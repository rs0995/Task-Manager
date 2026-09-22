const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme, Tray, nativeImage, crashReporter } = require('electron');
if (!app) {
  throw new Error('Electron app failed to initialize. Ensure ELECTRON_RUN_AS_NODE is not set when launching the app.');
}
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dgram = require('dgram');
const os = require('os');
const { initDatabase, getDatabase, closeDatabase, ensureSystemAdmin, SYSTEM_ADMIN_NAME, SUPERADMIN_ROLE } = require('./database');
const { downloadAttachmentFile, downloadDriveAttachmentFile, pullSnapshotToLocalCache, pullDriveSnapshotToLocalCache, pushMutations, queueDriveMutations, getDriveQueueStatus } = require('./client-sync');
const { appsScriptGet, normalizeDriveScriptUrl } = require('./drive-web-sync');

function getCrashLogDir() {
  // location that originally caused the connection-mode.json EPERM bug.
  // That meant writeCrashLog() has likely been silently failing for every
  // error on every non-elevated install this whole time: no permission to
  // create the directory, so the write inside writeCrashLog()'s own
  // try/catch just swallowed it, leaving zero diagnostic trail. Moved to
  // userData (set up below, before app ready) for the same reason as the
  // connection-mode fix.
  try {
    return path.join(app.getPath('userData'), 'crash-logs');
  } catch {
    return path.join(getInstallDir(), 'crash-logs');
  }
}

function isServerMode() {
  const exeName = path.basename(process.execPath || '');
  const appName = app?.getName?.() || '';
  return process.argv.includes('--erp-server') || /\bserver\b/i.test(exeName) || /\bserver\b/i.test(appName);
}

function isRemoteMode() {
  const exeName = path.basename(process.execPath || '');
  const appName = app?.getName?.() || '';
  // switch when it relaunches the process.
  if (process.argv.includes('--erp-remote')) return true;
  if (process.argv.includes('--erp-client')) return false;
  if (/\bremote\b/i.test(exeName) || /\bremote\b/i.test(appName)) return true;
  // Lowest-priority fallback: a persisted preference saved by the in-app
  // Connection Mode toggle. Only consulted when neither an explicit flag nor
  // installers never reach this branch, but a future merged single-exe
  // build relies on it.
  const stored = readStoredConnectionModePreference();
  return stored === 'remote';
}

function writeCrashLog(reason, error, detail = {}) {
  try {
    const dir = getCrashLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `crash-${stamp}.log`);
    const payload = [
      `Reason: ${reason}`,
      `Time: ${new Date().toISOString()}`,
      `Version: ${app?.getVersion?.() || 'unknown'}`,
      `Mode: ${isServerMode() ? 'server' : isRemoteMode() ? 'remote' : 'client'}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Node: ${process.version}`,
      `Electron: ${process.versions?.electron || 'unknown'}`,
      `Chrome: ${process.versions?.chrome || 'unknown'}`,
      `Command: ${process.argv.join(' ')}`,
      `Detail: ${JSON.stringify(detail || {}, null, 2)}`,
      '',
      error?.stack || error?.message || String(error || ''),
      '',
    ].join('\n');
    fs.writeFileSync(file, payload, 'utf8');
    return file;
  } catch {
    return '';
  }
}

process.on('uncaughtException', (error) => {
  writeCrashLog('uncaughtException', error);
});

process.on('unhandledRejection', (error) => {
  writeCrashLog('unhandledRejection', error);
});

let mainWindow = null;
let serverWindow = null;
let managedServer = null;
let tray = null;
let isQuitting = false;
let launchedAtLogin = false;
let launchedAt = Date.now();
const isDev = !app.isPackaged;
const DISPLAY_VERSION = app.getVersion();
const DEFAULT_USER_PASSWORD = '12345';
const BASE_ROLE = 'Executive';
const DRIVE_CONNECTION_TEST_CODE = 'ERP_DRIVE_WEB_ACCESS_V1';
const RUN_AS_SERVER = isServerMode();

const LEGACY_REMOTE_USERDATA_NAME = 'Task Manager Remote';

function getRuntimeAppIdentity() {
  if (RUN_AS_SERVER) {
    return {
      id: 'com.rippl.task-manager.server',
      userDataName: 'Task Manager Server',
    };
  }
  // Client and Remote Access used to ship as two separate installers, each
  // both runtime modes share this identity, settings store, and window
  // state. See migrateLegacyRemoteUserDataIfNeeded() for the one-time
  // import of settings from the old separate Remote install, if present.
  return {
    id: 'com.rippl.task-manager',
    userDataName: 'Task Manager',
  };
}

try {
  const identity = getRuntimeAppIdentity();
  app.setAppUserModelId(identity.id);
  app.setPath('userData', path.join(app.getPath('appData'), 'RIPPL', identity.userDataName));
} catch (error) {
  writeCrashLog('app-identity-init-failed', error);
}

// Now that userData points somewhere actually writable, point crash
// dumps/reporting there too (see getCrashLogDir()'s comment above).
try {
  app.setPath('crashDumps', getCrashLogDir());
  crashReporter.start({ submitURL: '', uploadToServer: false, compress: false });
} catch (error) {
  writeCrashLog('crash-reporter-start-failed', error);
}

// RUN_AS_REMOTE's resolution (isRemoteMode()) falls back to a stored
// connection-mode preference file under userData when no explicit flag or
// writable, per-user location (above) before this runs. Getting this order
// wrong is exactly how a previous version of this file ended up writing
// connection-mode.json into the read-only install directory instead.
const RUN_AS_REMOTE = !RUN_AS_SERVER && isRemoteMode();
const ATTACHMENT_TABLES = new Set([
  'task_attachments',
  'task_comment_attachments',
  'subtask_comment_attachments',
  'issue_comment_attachments',
]);
const DISCOVERY_MESSAGE = 'ERP_TASK_MANAGER_DISCOVER_v1';
const DISCOVERY_PORT = Number(process.env.ERP_SERVER_PORT || 3587);
const DISCOVERY_SCAN_SPAN = Number(process.env.ERP_SERVER_DISCOVERY_SCAN_SPAN || 25);
let syncConfig = null;
let syncPullInFlight = false;
let syncPushQueueInFlight = false;
let syncPollingTimer = null;
let activeLoginUser = '';
let primaryConfigOverrides = {};

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  writeCrashLog('second-instance-exit', null, { message: `Another ${getAppDisplayName()} instance is already running.` });
  app.quit();
} else {
  app.on('second-instance', () => {
    if (launchedAtLogin && Date.now() - launchedAt < 30000 && getBooleanSetting('minimizeToTray', true)) {
      return;
    }
    showMainWindow();
  });
}

app.on('render-process-gone', (_event, webContents, details) => {
  writeCrashLog('render-process-gone', null, {
    reason: details?.reason || '',
    exitCode: details?.exitCode,
    url: webContents?.getURL?.() || '',
  });
});

function getInstallDir() {
  return app?.isPackaged ? path.dirname(process.execPath) : process.cwd();
}

function getDbFallbackDir(kind = '') {
  return path.join(app.getPath('userData'), kind || 'data');
}

function getDefaultClientDataDir() {
  // default. That's the same install-directory problem connection-mode.json
  // had, except this is the folder the local SQLite cache, attachments,
  // not just one settings file. userData is the standard, always-writable,
  // per-user location for exactly this kind of app-owned mutable data.
  try {
    return path.join(app.getPath('userData'), RUN_AS_REMOTE ? 'client-data Remote' : 'client-data');
  } catch {
    return path.join(getInstallDir(), RUN_AS_REMOTE ? 'client-data Remote' : 'client-data');
  }
}

// Stored under userData (per-user, always writable) rather than next to the
// executable. It used to live in the install directory so the preference
// but a default Windows install puts that directory under
// C:\Program Files\..., which a normal (non-elevated) user cannot write to
// at runtime. Since identity/userData is now unified for Client and
// Remote (see getRuntimeAppIdentity() above, set up before RUN_AS_REMOTE is
// even computed), there's no longer a reason to use the install directory.
const CONNECTION_MODE_FILE = 'connection-mode.json';

function getConnectionModeFilePath() {
  try {
    return path.join(app.getPath('userData'), CONNECTION_MODE_FILE);
  } catch {
    return '';
  }
}

function readStoredConnectionModePreference() {
  try {
    const file = getConnectionModeFilePath();
    if (!file || !fs.existsSync(file)) return '';
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const mode = String(parsed?.mode || '').trim().toLowerCase();
    return mode === 'remote' || mode === 'client' ? mode : '';
  } catch {
    return '';
  }
}

function writeStoredConnectionModePreference(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized !== 'remote' && normalized !== 'client') {
    return { ok: false, error: 'Mode must be "client" or "remote".' };
  }
  const file = getConnectionModeFilePath();
  if (!file) return { ok: false, error: 'Could not resolve a writable location for the connection mode file.' };
  try {
    const payload = JSON.stringify({ mode: normalized, savedAt: new Date().toISOString() }, null, 2);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload, 'utf8');
    return { ok: true, path: file };
  } catch (error) {
    writeCrashLog('connection-mode-file-write-failed', error, { mode: normalized, file });
    return { ok: false, error: String(error?.message || error) };
  }
}

function hasExistingDatabase(dir) {
  if (!dir) return false;
  try {
    const dbPath = path.join(dir, 'erp_tasks.db');
    return fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
  } catch {
    return false;
  }
}

function resolveServerDbBaseDir() {
  const configured = String(configStore?.get('dbBaseDir') || '').trim();
  const candidates = [
    configured,
    getInstallDir(),
    path.join(getInstallDir(), 'server-data'),
    process.cwd(),
    path.join(process.cwd(), 'server-data'),
    getDbFallbackDir('server-data'),
  ].filter(Boolean);
  const existing = candidates.find(hasExistingDatabase);
  if (existing) {
    configStore?.set('dbBaseDir', existing);
    return existing;
  }
  return configured || getDbFallbackDir('server-data');
}

function ensureWritableDirectory(dir, fallbackDir, configKey = '') {
  const target = String(dir || '').trim() || fallbackDir;
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.write-test-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return target;
  } catch (error) {
    writeCrashLog('db-directory-unavailable', error, { requestedDir: target, fallbackDir });
    if (!fallbackDir || fallbackDir === target) throw error;
    fs.mkdirSync(fallbackDir, { recursive: true });
    const probe = path.join(fallbackDir, `.write-test-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    if (configKey) configStore?.set(configKey, fallbackDir);
    return fallbackDir;
  }
}

function getAppDisplayName() {
  return RUN_AS_SERVER ? 'Task Manager Server' : RUN_AS_REMOTE ? 'Task Manager Remote Access' : 'Task Manager';
}

function showAboutDialog() {
  const ownerWindow = BrowserWindow.getFocusedWindow() || serverWindow || mainWindow || undefined;
  dialog.showMessageBox(ownerWindow, {
    type: 'info',
    title: `About ${getAppDisplayName()}`,
    message: getAppDisplayName(),
    detail: [
      `Build version: ${DISPLAY_VERSION}`,
      `Electron: ${process.versions?.electron || 'unknown'}`,
      `Chrome: ${process.versions?.chrome || 'unknown'}`,
      'Built with Electron + React',
      '2026 RIPPL',
    ].join('\n'),
  });
}

app.on('child-process-gone', (_event, details) => {
  writeCrashLog('child-process-gone', null, details || {});
});

// General app settings live in userData as app-config.json.
let windowStateStore = null;
let configStore = null;
try {
  const Store = require('electron-store');
  const storeSuffix = isServerMode() ? 'server' : 'client';
  windowStateStore = new Store({
    name: `window-state-${storeSuffix}`,
    defaults: {
      width: 1280,
      height: 820,
      x: undefined,
      y: undefined,
      isMaximized: false,
    },
  });
  configStore = new Store({
    name: 'app-config',
    defaults: {
      dbBaseDir: null,
      setupCompleted: false,
      autoLaunch: false,
      desktopShortcut: false,
      minimizeToTray: true,
      trayHintShown: false,
    },
  });
} catch (e) {
  writeCrashLog('electron-store-init-failed', e);
  console.warn('electron-store not available, window state won\'t persist:', e.message);
}

// Client and Remote used to be different exes with different app ids, so a
// device that had Remote Access installed has its old settings sitting in
// a sibling userData folder ("Task Manager Remote") that the now-merged
// app will never look at on its own. Copy the Remote-only settings across
// once, the first time the merged app runs on that device, so upgrading
// doesn't silently drop a configured Drive relay.
function getLegacyRemoteUserDataDir() {
  try {
    return path.join(app.getPath('appData'), 'RIPPL', LEGACY_REMOTE_USERDATA_NAME);
  } catch {
    return '';
  }
}

function migrateLegacyRemoteUserDataIfNeeded() {
  if (RUN_AS_SERVER || !configStore) return;
  try {
    if (configStore.get('migratedLegacyRemoteUserData')) return;
    const legacyDir = getLegacyRemoteUserDataDir();
    const legacyConfigFile = legacyDir ? path.join(legacyDir, 'app-config-remote.json') : '';
    if (legacyConfigFile && fs.existsSync(legacyConfigFile)) {
      const legacy = readJsonObjectFile(legacyConfigFile);
      const carryKeys = [
        'directQueuePollSeconds', 'driveScriptUrl', 'driveToken', 'driveSyncEnabled',
        'clientCacheDir', 'dbBaseDir',
      ];
      for (const key of carryKeys) {
        if (Object.prototype.hasOwnProperty.call(legacy, key) && !configStore.has(key)) {
          configStore.set(key, legacy[key]);
        }
      }
      // mode forward too, so it doesn't quietly come back up as Client.
      if (!readStoredConnectionModePreference()) {
        writeStoredConnectionModePreference('remote');
      }
      writeCrashLog('legacy-remote-userdata-migrated', null, { from: legacyConfigFile, keys: Object.keys(legacy || {}) });
    }
    configStore.set('migratedLegacyRemoteUserData', true);
  } catch (error) {
    writeCrashLog('legacy-remote-userdata-migration-failed', error);
  }
}

migrateLegacyRemoteUserDataIfNeeded();

function migrateRemoteLocalConfigIfNeeded() {
  return;
}

migrateRemoteLocalConfigIfNeeded();

function getBooleanSetting(key, fallback = false) {
  return !!(configStore?.get(key, fallback));
}

function getPrimaryConfigStorePath() {
  try {
    if (configStore?.path) return configStore.path;
  } catch {}
  try {
    return path.join(app.getPath('userData'), 'app-config.json');
  } catch {
    return '';
  }
}

function readJsonObjectFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeFileWithRetry(file, text) {
  // Shared by every config write path in this file. A transient handle on
  // Windows write fail with EPERM/EBUSY even though nothing is genuinely
  // wrong with permissions. Retrying with a short backoff resolves it when
  // the lock is transient, which is the common case; a real, permanent
  // permissions problem will still fail after exhausting retries.
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const isRetryable = (error) => ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code);
  const delays = [25, 50, 100, 200, 400, 800];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
  throw lastError || new Error(`Could not write ${file}`);
}

async function writeJsonObjectFile(file, payload) {
  const text = JSON.stringify(payload || {}, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const isRetryable = (error) => ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code);

  // Renaming a temp file OVER an existing destination is the operation
  // The first-ever write never hits this, since the destination doesn't
  // the first time, fails every time after" is the signature of this
  // specific failure mode rather than a real permissions problem.
  const delays = [25, 50, 100, 200, 400, 800];
  let lastError = null;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === delays.length) break;
      await sleep(delays[attempt]);
    }
  }

  // directly, with the same retry treatment, before giving up entirely.
  try {
    await writeFileWithRetry(file, text);
    try { fs.unlinkSync(tmp); } catch {}
    return;
  } catch (error) {
    lastError = error;
  }

  try { fs.unlinkSync(tmp); } catch {}
  throw lastError || new Error(`Could not write ${file}`);
}

function statSnapshot(file) {
  try {
    if (!fs.existsSync(file)) return { exists: false };
    const stat = fs.statSync(file);
    return { exists: true, size: stat.size, mtime: stat.mtimeMs };
  } catch (error) {
    return { exists: false, statError: String(error?.message || error) };
  }
}

async function injectPrimaryConfigJson(patch = {}) {
  const cleanPatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) cleanPatch[key] = value;
  }
  const keys = Object.keys(cleanPatch);
  if (!keys.length) return { ok: true, skipped: true };
  const file = getPrimaryConfigStorePath();
  if (!file) return { ok: false, error: 'App config file path is not available.' };

  // Diagnostic: always logged, success or failure, so we can see the full
  // sequence across multiple Save attempts rather than only when something
  // throws. Specifically captures whether the sync engine is actively
  // polling at the moment of write, and the file's actual on-disk state
  // before and after, since "the write silently has no effect" and "the
  // write throws an error" need different fixes and look identical from
  // the UI alone.
  const beforeStat = statSnapshot(file);
  const writeContext = {
    file,
    keys,
    syncEnabled: !!syncConfig?.enabled,
    syncMode: syncConfig?.mode || '',
    syncPollingActive: !!syncPollingTimer,
    beforeStat,
  };

  const writeAndVerify = async () => {
    let base = {};
    try {
      if (configStore?.store && typeof configStore.store === 'object') {
        base = { ...configStore.store };
      }
    } catch {}
    base = { ...base, ...readJsonObjectFile(file), ...cleanPatch };
    await writeJsonObjectFile(file, base);
    const saved = readJsonObjectFile(file);
    const failedKey = keys.find(key => JSON.stringify(saved[key]) !== JSON.stringify(cleanPatch[key]));
    if (failedKey) {
      throw new Error(`Saved config verification failed for ${failedKey}.`);
    }
    primaryConfigOverrides = { ...primaryConfigOverrides, ...cleanPatch };
    return saved;
  };

  try {
    const config = await writeAndVerify();
    writeCrashLog('config-write-diagnostic-success', null, {
      ...writeContext,
      afterStat: statSnapshot(file),
    });
    return { ok: true, path: file, config };
  } catch (error) {
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o666);
      const config = await writeAndVerify();
      writeCrashLog('config-write-diagnostic-success-after-chmod-retry', error, {
        ...writeContext,
        afterStat: statSnapshot(file),
      });
      return { ok: true, path: file, config, recovered: true };
    } catch (retryError) {
      writeCrashLog('primary-config-json-write-failed', retryError, {
        ...writeContext,
        afterStat: statSnapshot(file),
        firstError: String(error?.message || error),
      });
      return { ok: false, path: file, error: String(retryError?.message || retryError) };
    }
  }
}

function getAutoLaunchSetting() {
  try {
    const login = app.getLoginItemSettings?.();
    if (typeof login?.openAtLogin === 'boolean') return !!login.openAtLogin;
  } catch {}
  return getBooleanSetting('autoLaunch', false);
}

function detectLaunchedAtLogin() {
  try {
    const login = app.getLoginItemSettings?.();
    if (login?.wasOpenedAtLogin || login?.wasOpenedAsHidden) return true;
  } catch {}
  const args = process.argv.map(arg => String(arg || '').toLowerCase());
  return args.includes('--hidden') || args.includes('--squirrel-firstrun');
}

function setAutoLaunch(enabled) {
  const openAtLogin = !!enabled;
  try {
    cleanupBrokenElectronStartupEntries();
    if (RUN_AS_SERVER) {
      cleanupLegacyStartupEntries('server');
    } else {
      // Client and Remote are now one merged executable, so this device
      // may carry stale registry startup entries from either flavor's old
      // matches the currently active mode.
      cleanupLegacyStartupEntries('client');
      cleanupLegacyStartupEntries('remote');
    }
    const loginOptions = {
      openAtLogin,
      openAsHidden: true,
      path: process.execPath,
    };
    const launchArgs = [];
    if (!app.isPackaged) launchArgs.push(app.getAppPath());
    if (RUN_AS_SERVER) launchArgs.push('--erp-server');
    if (RUN_AS_REMOTE) launchArgs.push('--erp-remote');
    if (launchArgs.length) loginOptions.args = launchArgs;
    app.setLoginItemSettings(loginOptions);
    configStore?.set('autoLaunch', openAtLogin);
    refreshTrayMenu();
    return { ok: true, enabled: openAtLogin };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function cleanupBrokenElectronStartupEntries() {
  if (process.platform !== 'win32') return;
  try {
    const { execFileSync } = require('child_process');
    const regExe = getWindowsRegExe();
    const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const output = execFileSync(regExe, ['query', runKey], { windowsHide: true, encoding: 'utf8' });
    const appPath = String(app.getAppPath?.() || '').toLowerCase();
    for (const line of String(output || '').split(/\r?\n/)) {
      const match = line.match(/^\s+(.+?)\s+REG_\w+\s+(.+)$/);
      if (!match) continue;
      const valueName = String(match[1] || '').trim();
      const valueData = String(match[2] || '').trim();
      const lowerData = valueData.toLowerCase();
      const pointsAtDevElectron = lowerData.includes('\\node_modules\\electron\\dist\\electron.exe');
      const includesAppPath = appPath && lowerData.includes(appPath);
      if (!pointsAtDevElectron || includesAppPath) continue;
      try {
        execFileSync(regExe, ['delete', runKey, '/v', valueName, '/f'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }
  } catch {}
}

function getWindowsRegExe() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const fullPath = path.join(root, 'System32', 'reg.exe');
  return fs.existsSync(fullPath) ? fullPath : 'reg';
}

function cleanupLegacyStartupEntries(mode) {
  if (process.platform !== 'win32') return;
  const names = mode === 'server'
    ? ['ERP Tasks Server', 'Task Manager Server']
    : mode === 'remote'
      ? ['ERP Tasks Remote', 'Task Manager Remote', 'Task Manager Remote Access']
      : ['ERP Tasks Client', 'Task Manager Client', 'Task Manager'];
  try {
    const { execFileSync } = require('child_process');
    const regExe = getWindowsRegExe();
    for (const name of names) {
      try {
        execFileSync(regExe, [
          'delete',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          '/v',
          name,
          '/f',
        ], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }
  } catch {}
}

function getDesktopShortcutPath() {
  return path.join(app.getPath('desktop'), `${getAppDisplayName()}.lnk`);
}

function setDesktopShortcut(enabled) {
  const shouldCreate = !!enabled;
  if (process.platform !== 'win32') {
    configStore?.set('desktopShortcut', shouldCreate);
    return { ok: false, error: 'Desktop shortcut is supported on Windows only.', enabled: shouldCreate };
  }
  try {
    const shortcutPath = getDesktopShortcutPath();
    if (!shouldCreate) {
      if (fs.existsSync(shortcutPath)) fs.unlinkSync(shortcutPath);
      configStore?.set('desktopShortcut', false);
      return { ok: true, enabled: false };
    }
    const result = shell.writeShortcutLink(shortcutPath, 'create', {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: getAppDisplayName(),
    });
    if (!result) {
      return { ok: false, error: 'Could not create desktop shortcut.', enabled: false };
    }
    configStore?.set('desktopShortcut', true);
    return { ok: true, enabled: true, path: shortcutPath };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), enabled: false };
  }
}

function getAppSettingsSnapshot() {
  let taskIdPrefix = '';
  let taskIdNextNumber = '';
  let tableColumnWidths = {};
  let tableRowHeights = {};
  try {
    const currentDb = getDatabase();
    if (currentDb) {
      const rows = currentDb.prepare("SELECT key, value FROM app_settings WHERE key IN ('taskIdPrefix', 'taskIdNextNumber', 'tableColumnWidths', 'tableRowHeights')").all();
      for (const row of rows) {
        const parsed = JSON.parse(row.value);
        if (row.key === 'taskIdPrefix') taskIdPrefix = String(parsed || '');
        if (row.key === 'taskIdNextNumber') taskIdNextNumber = String(parsed || '');
        if (row.key === 'tableColumnWidths' && parsed && typeof parsed === 'object') tableColumnWidths = parsed;
        if (row.key === 'tableRowHeights' && parsed && typeof parsed === 'object') tableRowHeights = parsed;
      }
    }
  } catch {}
  return {
    dbBaseDir: getConfiguredDataDir(),
    autoLaunch: getAutoLaunchSetting(),
    desktopShortcut: getBooleanSetting('desktopShortcut', false),
    minimizeToTray: getBooleanSetting('minimizeToTray', true),
    serverUrl: String(configStore?.get('serverUrl') || process.env.ERP_SERVER_URL || ''),
    serverTokenConfigured: !!String(configStore?.get('serverToken') || process.env.ERP_SERVER_TOKEN || '').trim(),
    directQueuePollSeconds: getLocalConfigValue('directQueuePollSeconds', 'ERP_DIRECT_QUEUE_POLL_SECONDS', '10'),
    driveScriptUrl: RUN_AS_REMOTE ? getLocalConfigValue('driveScriptUrl', 'ERP_DRIVE_SCRIPT_URL') : '',
    driveToken: RUN_AS_REMOTE ? getLocalConfigValue('driveToken', 'ERP_DRIVE_TOKEN') : '',
    driveSyncEnabled: getDriveSyncEnabled(),
    driveTokenConfigured: false,
    taskIdPrefix,
    taskIdNextNumber,
    tableColumnWidths,
    tableRowHeights,
  };
}

function getConnectionModeSnapshot() {
  const settings = getAppSettingsSnapshot();
  return {
    mode: RUN_AS_REMOTE ? 'remote' : 'client',
    canSwitch: !RUN_AS_SERVER,
    displayName: getAppDisplayName(),
    serverUrl: settings.serverUrl || '',
    serverTokenConfigured: !!settings.serverTokenConfigured,
    driveScriptUrl: settings.driveScriptUrl || '',
  };
}

async function setConnectionMode(targetMode) {
  if (RUN_AS_SERVER) {
    return { ok: false, error: 'Connection mode does not apply to the Server app.' };
  }
  const normalized = String(targetMode || '').trim().toLowerCase();
  if (normalized !== 'client' && normalized !== 'remote') {
    return { ok: false, error: 'Mode must be "client" or "remote".' };
  }
  const currentMode = RUN_AS_REMOTE ? 'remote' : 'client';
  if (normalized === currentMode) {
    return { ok: true, unchanged: true, mode: currentMode };
  }
  const wantRemote = normalized === 'remote';

  // comes back up in the mode they chose. Non-fatal: even if this write
  // fails (e.g. blocked by antivirus/EDR software), we still relaunch into
  // the new mode below via an explicit argv flag, so THIS switch still
  // takes effect. Only a future cold start (new shortcut double-click,
  // reboot) would fail to pick up the new mode if this keeps failing.
  const fileResult = writeStoredConnectionModePreference(normalized);
  let persistenceWarning;
  if (!fileResult.ok) {
    writeCrashLog('connection-mode-preference-write-failed', new Error(fileResult.error || 'unknown'), { targetMode: normalized });
    persistenceWarning = `This switch will take effect now, but may not survive a full restart: ${fileResult.error || 'could not save the preference'}.`;
  }

  // Stop the sync poll timer and try to release this client's server-side
  // login session before the process exits, so the old connection doesn't
  // look "stuck logged in" to a LAN server or Drive relay. Best-effort with
  // a short timeout: a common reason to switch modes is that the current
  // connection is unreachable, so we must not let this hang the restart.
  try {
    await Promise.race([
      disconnectSyncConnection(),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  } catch (error) {
    writeCrashLog('connection-mode-disconnect-failed', error, { targetMode: normalized });
  }

  // Close the SQLite handle cleanly before the restart, so no WAL file is
  // left open across the process switch.
  try {
    closeDatabase();
  } catch (error) {
    writeCrashLog('connection-mode-close-db-failed', error, { targetMode: normalized });
  }

  // If auto-launch-at-login is on, carry the new mode into the login item's
  // launch arguments too, so a reboot doesn't silently revert the mode.
  try {
    const loginSettings = app.getLoginItemSettings?.();
    if (loginSettings?.openAtLogin) {
      const launchArgs = [];
      if (!app.isPackaged) launchArgs.push(app.getAppPath());
      if (wantRemote) launchArgs.push('--erp-remote');
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, path: process.execPath, args: launchArgs });
    }
  } catch (error) {
    writeCrashLog('connection-mode-login-item-update-failed', error, { targetMode: normalized });
  }

  const relaunchArgs = (process.argv.slice(1) || [])
    .filter(arg => arg !== '--erp-remote' && arg !== '--erp-client' && arg !== '--erp-server');
  if (wantRemote) relaunchArgs.push('--erp-remote');

  try {
    app.relaunch({ args: relaunchArgs });
    app.exit(0);
    return { ok: true, relaunching: true, mode: normalized, warning: persistenceWarning };
  } catch (error) {
    writeCrashLog('connection-mode-relaunch-failed', error, { targetMode: normalized });
    return { ok: false, error: 'Saved the new mode, but could not restart automatically. Please quit and reopen the app.' };
  }
}

function getLocalConfigValue(key, envName = '', fallback = '') {
  if (Object.prototype.hasOwnProperty.call(primaryConfigOverrides, key)) {
    return String(primaryConfigOverrides[key] ?? '');
  }
  try {
    if (configStore?.has?.(key)) return String(configStore.get(key) ?? '');
    const stored = configStore?.get?.(key);
    if (stored !== undefined && stored !== null) return String(stored);
  } catch {}
  return String((envName && process.env[envName]) || fallback || '');
}

function getDriveSyncEnabled() {
  if (!RUN_AS_REMOTE) return false;
  const driveScriptUrl = normalizeDriveScriptUrl(getLocalConfigValue('driveScriptUrl', 'ERP_DRIVE_SCRIPT_URL'));
  if (!driveScriptUrl) return false;
  if (Object.prototype.hasOwnProperty.call(primaryConfigOverrides, 'driveSyncEnabled')) {
    return primaryConfigOverrides.driveSyncEnabled !== false;
  }
  try {
    if (configStore?.has?.('driveSyncEnabled')) return configStore.get('driveSyncEnabled') !== false;
  } catch {}
  return true;
}

function getServerConnectionSnapshot(initialPull = { ok: true, skipped: true }, health = null) {
  const settings = getAppSettingsSnapshot();
  const driveScriptUrl = normalizeDriveScriptUrl(settings.driveScriptUrl);
  const serverUrl = normalizeServerUrlInput(settings.serverUrl);
  const tokenConfigured = !!settings.serverTokenConfigured;
  const driveEnabled = !!driveScriptUrl && settings.driveSyncEnabled !== false;
  const enabled = driveEnabled || !!serverUrl;
  const hasHealthResult = health && Object.prototype.hasOwnProperty.call(health, 'ok');
  const online = driveEnabled
    ? ((hasHealthResult ? !!health.ok : true) && !!initialPull?.ok)
    : (enabled && tokenConfigured && (hasHealthResult ? !!health.ok : !!initialPull?.ok));
  const mode = driveEnabled ? 'drive' : 'lan';
  return {
    enabled,
    online,
    serverUrl: driveEnabled ? driveScriptUrl : serverUrl,
    mode,
    pendingCount: Number(initialPull?.pendingCount || 0),
    lastError: !enabled ? '' : (online ? '' : (initialPull?.error || health?.error || (driveEnabled ? 'Drive not connected' : 'Server not connected'))),
  };
}

function normalizeServerUrlInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!url.port) url.port = '3587';
    return url.toString().replace(/\/$/, '');
  } catch {
    return withProtocol.replace(/\/$/, '');
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

async function checkServerHealth(serverUrl) {
  const normalized = normalizeServerUrlInput(serverUrl);
  if (!normalized) return { ok: false, error: 'Server URL is required.' };
  const token = String(configStore?.get('serverToken') || process.env.ERP_SERVER_TOKEN || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${normalized}/health`, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.role !== 'erp-server') {
      return { ok: false, serverUrl: normalized, error: 'No ERP server responded.' };
    }
    if (!token) {
      return { ok: false, serverUrl: normalized, serverTime: data.serverTime || '', error: 'Server found, token not configured. Use Fetch.' };
    }
    const authResponse = await fetch(`${normalized}/api/auth-check`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!authResponse.ok) {
      return { ok: false, serverUrl: normalized, serverTime: data.serverTime || '', error: 'Server found, token rejected. Use Fetch.' };
    }
    return { ok: true, serverUrl: normalized, serverTime: data.serverTime || '' };
  } catch (error) {
    return { ok: false, serverUrl: normalized, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkDriveHealth(driveScriptUrl, driveToken) {
  const normalized = normalizeDriveScriptUrl(driveScriptUrl);
  const token = String(driveToken || '').trim();
  if (!normalized) return { ok: false, error: 'Apps Script Web App URL is required.' };
  if (!token) return { ok: false, error: 'Drive access token is required.' };
  try {
    const challenge = `${DRIVE_CONNECTION_TEST_CODE}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const result = await appsScriptGet(normalized, token, 'connectionTest', {
      appCode: DRIVE_CONNECTION_TEST_CODE,
      challenge,
    });
    if (result.challenge !== challenge || result.appCode !== DRIVE_CONNECTION_TEST_CODE) {
      return { ok: false, drive: true, error: 'Drive connection test failed: challenge response did not match.' };
    }
    return {
      ok: true,
      drive: true,
      serverTime: result.serverTime || '',
      folderId: result.folderId || '',
      folderName: result.folderName || '',
      dbFound: !!result.dbFound,
      dbFileName: result.dbFileName || '',
      snapshotMode: result.snapshotMode || '',
      dbUpdatedAt: result.dbUpdatedAt || '',
    };
  } catch (error) {
    const message = String(error?.message || error);
    const hint = /Unknown action/i.test(message)
      ? ' Update and redeploy the Apps Script with the latest connectionTest action.'
      : '';
    return { ok: false, drive: true, error: `${message}${hint}` };
  }
}

function getLanBroadcastAddresses() {
  // 255.255.255.255 alone isn't reliable on a machine with more than one
  // routes a single global-broadcast send out through whichever interface
  // its default route picks, so a server only reachable on the other
  // interface never sees the probe. A subnet-directed broadcast (e.g.
  // 192.168.1.255 for an interface on 192.168.1.x/24) forces the OS to
  // route it out specifically through the interface that owns that
  // subnet, so we compute one for every active IPv4 interface and send to
  // all of them, with the global address kept as a fallback.
  const addresses = new Set(['255.255.255.255']);
  try {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const net of iface || []) {
        if (net.family !== 'IPv4' || net.internal) continue;
        const ipParts = String(net.address || '').split('.').map(Number);
        const maskParts = String(net.netmask || '255.255.255.0').split('.').map(Number);
        if (ipParts.length !== 4 || maskParts.length !== 4 || ipParts.some(Number.isNaN) || maskParts.some(Number.isNaN)) continue;
        const broadcastParts = ipParts.map((octet, i) => octet | (255 - maskParts[i]));
        addresses.add(broadcastParts.join('.'));
      }
    }
  } catch {}
  return [...addresses];
}

function discoverLanServers(timeoutMs = 1800) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const servers = new Map();
    const finish = () => {
      try { socket.close(); } catch {}
      resolve([...servers.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);

    socket.on('message', (message, rinfo) => {
      try {
        const data = JSON.parse(String(message || ''));
        if (data?.role !== 'erp-server') return;
        const responseIp = String(rinfo.address || '').replace(/^::ffff:/, '').trim();
        const advertisedIp = String(data.ip || '').trim();
        const ip = responseIp || advertisedIp;
        const port = Number(data.port || DISCOVERY_PORT);
        const url = normalizeServerUrlInput(ip ? `${ip}:${port}` : data.url);
        if (!url) return;
        servers.set(url, {
          name: String(data.name || 'ERP Server'),
          ip,
          port,
          url,
          advertisedUrl: normalizeServerUrlInput(data.url || (advertisedIp ? `${advertisedIp}:${port}` : '')),
          token: String(data.token || ''),
          addresses: Array.isArray(data.addresses) ? data.addresses : [],
        });
      } catch {}
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    socket.bind(() => {
      try { socket.setBroadcast(true); } catch {}
      const payload = Buffer.from(DISCOVERY_MESSAGE);
      const ports = new Set([DISCOVERY_PORT]);
      for (let offset = 1; offset <= DISCOVERY_SCAN_SPAN; offset += 1) {
        const port = DISCOVERY_PORT + offset;
        if (port <= 65535) ports.add(port);
      }
      const broadcastAddresses = getLanBroadcastAddresses();
      for (const port of ports) {
        for (const address of broadcastAddresses) {
          socket.send(payload, port, address);
        }
      }
    });
  });
}

function showLanServerPromptWindow(servers) {
  return new Promise((resolve) => {
    if (!Array.isArray(servers) || !servers.length) {
      resolve(null);
      return;
    }
    const channel = `lan-server-choice:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners(channel);
      try {
        if (promptWindow && !promptWindow.isDestroyed()) promptWindow.close();
      } catch {}
      resolve(value);
    };
    const rows = servers.slice(0, 8).map((server, index) => `
      <label class="server-row">
        <input type="radio" name="server" value="${index}" ${index === 0 ? 'checked' : ''} />
        <span class="server-main">
          <span class="server-name">${escapeHtml(server.name || 'ERP Server')}</span>
          <span class="server-url">${escapeHtml(server.url)}${server.advertisedUrl && server.advertisedUrl !== server.url ? ` (advertised ${escapeHtml(server.advertisedUrl)})` : ''}</span>
        </span>
      </label>
    `).join('');
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "DM Sans", "Segoe UI", system-ui, sans-serif; background: rgba(15,23,42,0.36); color: #0f172a; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 18px; }
    .card { width: min(460px, 100%); background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 24px 70px rgba(15,23,42,0.24); padding: 24px; animation: pop .16s ease-out; }
    @keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
    .head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 18px; }
    .icon { width: 42px; height: 42px; border-radius: 10px; background: #ccfbf1; color: #0f766e; display: grid; place-items: center; font-weight: 800; flex: 0 0 auto; }
    h1 { font-size: 16px; line-height: 1.25; margin: 0 0 5px; font-weight: 700; letter-spacing: 0; }
    p { margin: 0; color: #64748b; font-size: 13px; line-height: 1.5; }
    .servers { display: grid; gap: 8px; margin: 18px 0 20px; }
    .server-row { display: flex; gap: 10px; align-items: center; padding: 11px 12px; border: 1px solid #e2e8f0; border-radius: 10px; cursor: pointer; background: #fff; }
    .server-row:has(input:checked) { border-color: #0d9488; background: #f0fdfa; box-shadow: 0 0 0 3px rgba(13,148,136,0.10); }
    input { accent-color: #0d9488; }
    .server-main { min-width: 0; display: grid; gap: 2px; }
    .server-name { font-size: 13px; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .server-url { font-size: 12px; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    button { border-radius: 8px; padding: 8px 14px; font-size: 13px; font-weight: 700; cursor: pointer; border: 1px solid #cbd5e1; background: #f8fafc; color: #334155; }
    button.primary { border-color: #0d9488; background: #0d9488; color: #fff; }
    button:hover { filter: brightness(.98); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        <div class="icon">OK</div>
        <div>
          <h1>ERP server found on LAN</h1>
          <p>Choose a server to connect this app. The latest server data will be pulled before changes are pushed.</p>
        </div>
      </div>
      <div class="servers">${rows}</div>
      <div class="actions">
        <button id="skip">Skip</button>
        <button id="connect" class="primary">Connect</button>
      </div>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const channel = ${JSON.stringify(channel)};
    document.getElementById('skip').addEventListener('click', () => ipcRenderer.send(channel, { action: 'skip' }));
    document.getElementById('connect').addEventListener('click', () => {
      const selected = document.querySelector('input[name="server"]:checked');
      ipcRenderer.send(channel, { action: 'connect', index: Number(selected && selected.value || 0) });
    });
  </script>
</body>
</html>`;
    let promptWindow = new BrowserWindow({
      width: 520,
      height: 430,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'ERP Server Found',
      backgroundColor: '#ffffff',
      icon: path.join(__dirname, 'App.ico'),
      modal: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });
    ipcMain.once(channel, (_event, payload = {}) => {
      if (payload.action === 'connect') {
        finish(servers[Math.max(0, Math.min(servers.length - 1, Number(payload.index || 0)))] || servers[0]);
      } else {
        finish(null);
      }
    });
    promptWindow.on('closed', () => finish(null));
    promptWindow.once('ready-to-show', () => promptWindow.show());
    promptWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

async function promptForLanServerConnectionForVersion() {
  if (RUN_AS_SERVER || RUN_AS_REMOTE || !configStore) return;
  if (configStore.get('lanServerDiscoveryVersion') === DISPLAY_VERSION) return;
  configStore.set('lanServerDiscoveryVersion', DISPLAY_VERSION);
  const servers = await discoverLanServers(2400);
  if (!servers.length) return;
  const selected = await showLanServerPromptWindow(servers);
  if (!selected) return;
  configStore.set('serverUrl', normalizeServerUrlInput(selected.url));
  if (selected.token) configStore.set('serverToken', String(selected.token || '').trim());
}

async function runFirstTimeSetup() {
  if (!configStore) return true;
  if (configStore.get('setupCompleted', false)) {
    if (!RUN_AS_SERVER && !configStore.get('clientCacheDir')) {
      configStore.set('setupCompleted', false);
    } else {
      return true;
    }
  }

  setAutoLaunch(true);
  configStore.set('minimizeToTray', true);

  const requiresUserSelectedLocalDataDir = RUN_AS_REMOTE;
  const defaultDbDir = RUN_AS_SERVER ? resolveServerDbBaseDir() : getDefaultClientDataDir();
  const folderKind = RUN_AS_SERVER ? 'server database' : RUN_AS_REMOTE ? 'remote local data' : 'client local data';
  const dbPrompt = await dialog.showMessageBox({
    type: 'question',
    buttons: requiresUserSelectedLocalDataDir ? ['Browse', 'Exit'] : ['Create DB Folder', 'Browse', 'Exit'],
    defaultId: 0,
    cancelId: requiresUserSelectedLocalDataDir ? 1 : 2,
    title: `${getAppDisplayName()} Setup`,
    message: requiresUserSelectedLocalDataDir ? `Select the ${folderKind} folder before starting.` : `Create the ${folderKind} folder before starting?`,
    detail: requiresUserSelectedLocalDataDir
      ? 'The Remote Access client will save its local DB copy, offline cache, pending sync queue, logs, and attachments in the folder you select.'
      : RUN_AS_SERVER
        ? `Default DB folder:\n${defaultDbDir}\n\nThe server will create a new erp_tasks.db there if one is missing.`
        : `Default local folder:\n${defaultDbDir}\n\nThe client will save its local DB copy, offline cache, pending sync queue, logs, and attachments there.`,
  });

  if (!requiresUserSelectedLocalDataDir && dbPrompt.response === 0) {
    try {
      const readyDir = ensureWritableDirectory(defaultDbDir, null, '');
      if (RUN_AS_SERVER) {
        configStore.set('dbBaseDir', readyDir);
      } else {
        configStore.set('clientCacheDir', readyDir);
        configStore.set('dbBaseDir', readyDir);
      }
    } catch (error) {
      const logPath = writeCrashLog('first-run-db-folder-create-failed', error, { defaultDbDir });
      await dialog.showMessageBox({
        type: 'error',
        title: 'Database Folder Error',
        message: 'Could not create or write to the default DB folder.',
        detail: `${error?.message || error}\n\nCrash log:\n${logPath || getCrashLogDir()}\n\nChoose Browse on the next screen to select another folder.`,
      });
      return runFirstTimeSetup();
    }
  } else if ((requiresUserSelectedLocalDataDir && dbPrompt.response === 0) || (!requiresUserSelectedLocalDataDir && dbPrompt.response === 1)) {
    const folder = await dialog.showOpenDialog({
      title: requiresUserSelectedLocalDataDir ? 'Select Remote Local Data Folder' : 'Select Database Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const selected = folder?.filePaths?.[0];
    if (folder.canceled || !selected) return false;
    if (!folder.canceled && selected) {
      try {
        const readyDir = ensureWritableDirectory(selected, null, '');
        if (RUN_AS_SERVER) {
          configStore.set('dbBaseDir', readyDir);
        } else {
          configStore.set('clientCacheDir', readyDir);
          configStore.set('dbBaseDir', readyDir);
        }
      } catch (error) {
        const logPath = writeCrashLog('first-run-custom-db-folder-failed', error, { selected });
        await dialog.showMessageBox({
          type: 'error',
          title: 'Database Folder Error',
          message: 'Could not create or write to the selected DB folder.',
          detail: `${error?.message || error}\n\nCrash log:\n${logPath || getCrashLogDir()}`,
        });
        return false;
      }
    }
  } else {
    return false;
  }

  await promptForLanServerConnectionForVersion();

  configStore.set('setupCompleted', true);
  return true;
}

function getDbBaseDir() {
  if (RUN_AS_SERVER) {
    const serverDir = resolveServerDbBaseDir();
    return ensureWritableDirectory(serverDir, getDbFallbackDir('server-data'), 'dbBaseDir');
  }
  const configured = configStore?.get('dbBaseDir');
  let baseDir = configured || getInstallDir();
  if (!configured) {
    try {
      const localDbPath = path.join(process.cwd(), 'erp_tasks.db');
      if (fs.existsSync(localDbPath)) {
        baseDir = process.cwd();
      }
    } catch {}
  }
  return ensureWritableDirectory(baseDir, getDbFallbackDir('data'), 'dbBaseDir');
}

function getClientCacheBaseDir() {
  const configured = process.env.ERP_CLIENT_CACHE_DIR || configStore?.get('clientCacheDir');
  const baseDir = configured || (RUN_AS_REMOTE ? getDefaultClientDataDir() : getDbFallbackDir('client-cache'));
  const fallbackDir = RUN_AS_REMOTE ? null : getDbFallbackDir('client-cache');
  return ensureWritableDirectory(baseDir, fallbackDir, configured && !process.env.ERP_CLIENT_CACHE_DIR ? 'clientCacheDir' : '');
}

function getConfiguredDataDir() {
  return RUN_AS_SERVER ? getDbBaseDir() : getClientCacheBaseDir();
}

async function setConfiguredDataDir(newPath) {
  if (!newPath) return { ok: false, error: 'Database folder is required.' };
  try {
    const readyDir = ensureWritableDirectory(newPath, null, '');
    if (RUN_AS_SERVER) {
      configStore?.set('dbBaseDir', readyDir);
      process.env.ERP_SERVER_DB_DIR = readyDir;
    } else {
      configStore?.set('clientCacheDir', readyDir);
      configStore?.set('dbBaseDir', readyDir);
    }
    return { ok: true, path: readyDir, restartRequired: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function getServerBackupRootDir() {
  const dir = path.join(getDbBaseDir(), 'server-backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getServerBackupLogPath() {
  return path.join(getServerBackupRootDir(), 'backup-log.json');
}

function safeBackupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function readServerBackupLog() {
  const logPath = getServerBackupLogPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeServerBackupLog(rows) {
  fs.writeFileSync(getServerBackupLogPath(), JSON.stringify(rows || [], null, 2), 'utf8');
}

function copyDirectoryContents(sourceDir, targetDir, options = {}) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  const excludeDirs = new Set((options.excludeDirs || []).map(p => path.resolve(p).toLowerCase()));
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const resolvedFrom = path.resolve(from);
    if (excludeDirs.has(resolvedFrom.toLowerCase())) continue;
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(from, to, options);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function clearDirectoryContents(targetDir, options = {}) {
  const excludeDirs = new Set((options.excludeDirs || []).map(p => path.resolve(p).toLowerCase()));
  if (!fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const fp = path.join(targetDir, entry.name);
    const resolved = path.resolve(fp);
    if (excludeDirs.has(resolved.toLowerCase())) continue;
    fs.rmSync(fp, { recursive: true, force: true });
  }
}

function createServerBackup() {
  if (!RUN_AS_SERVER) return { ok: false, error: 'Server backup is available only in server mode.' };
  const dbDir = getDbBaseDir();
  const backupRoot = getServerBackupRootDir();
  const stamp = safeBackupStamp();
  const backupPath = path.join(backupRoot, stamp);
  try {
    fs.mkdirSync(backupPath, { recursive: true });
    copyDirectoryContents(dbDir, backupPath, { excludeDirs: [backupRoot] });
    const meta = {
      id: stamp,
      createdAt: new Date().toISOString(),
      folderName: stamp,
      path: backupPath,
      sourceDir: dbDir,
      status: 'created',
    };
    fs.writeFileSync(path.join(backupPath, 'backup-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    const logRows = readServerBackupLog().filter(row => row.id !== stamp);
    logRows.unshift(meta);
    writeServerBackupLog(logRows);
    managedServer?.addLog?.('info', `Server backup created: ${backupPath}`);
    return { ok: true, backup: meta, backups: logRows };
  } catch (error) {
    try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch {}
    return { ok: false, error: String(error?.message || error) };
  }
}

function listServerBackups() {
  const backupRoot = getServerBackupRootDir();
  const logged = readServerBackupLog();
  const byId = new Map(logged.map(row => [String(row.id || row.folderName || ''), row]));
  try {
    for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (byId.has(id)) continue;
      const backupPath = path.join(backupRoot, id);
      byId.set(id, {
        id,
        folderName: id,
        path: backupPath,
        createdAt: fs.statSync(backupPath).birthtime.toISOString(),
        status: 'found',
      });
    }
  } catch {}
  return [...byId.values()]
    .filter(row => row?.id && row?.path && fs.existsSync(row.path))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function restoreServerBackup(backupId) {
  if (!RUN_AS_SERVER) return { ok: false, error: 'Restore is available only in server mode.' };
  const selected = listServerBackups().find(row => String(row.id || row.folderName) === String(backupId || ''));
  if (!selected) return { ok: false, error: 'Backup not found.' };
  const dbDir = getDbBaseDir();
  const backupRoot = getServerBackupRootDir();
  const backupPath = path.resolve(selected.path);
  if (!backupPath.toLowerCase().startsWith(path.resolve(backupRoot).toLowerCase())) {
    return { ok: false, error: 'Invalid backup path.' };
  }
  try {
    if (managedServer?.getServerStatus?.()?.running) {
      await managedServer.stopServer();
    }
    closeDatabase();
    clearDirectoryContents(dbDir, { excludeDirs: [backupRoot] });
    copyDirectoryContents(backupPath, dbDir, { excludeDirs: [] });
    try { fs.rmSync(path.join(dbDir, 'backup-meta.json'), { force: true }); } catch {}
    initDatabase(dbDir);
    ensureSystemAdmin(getDatabase());
    const nextStatus = await managedServer.startServer();
    const restored = {
      ...selected,
      restoredAt: new Date().toISOString(),
      status: 'restored',
    };
    const logRows = readServerBackupLog().map(row => String(row.id) === String(selected.id) ? { ...row, restoredAt: restored.restoredAt, status: 'restored' } : row);
    writeServerBackupLog(logRows);
    managedServer?.addLog?.('info', `Server restored from backup: ${backupPath}`);
    return { ok: true, restored, status: nextStatus, backups: listServerBackups() };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function getRuntimeDbBaseDir() {
  return syncConfig?.enabled ? getClientCacheBaseDir() : getDbBaseDir();
}

function loadSyncConfig() {
  const driveScriptUrl = RUN_AS_REMOTE ? normalizeDriveScriptUrl(getLocalConfigValue('driveScriptUrl', 'ERP_DRIVE_SCRIPT_URL')) : '';
  const driveToken = RUN_AS_REMOTE ? getLocalConfigValue('driveToken', 'ERP_DRIVE_TOKEN').trim() : '';
  if (driveScriptUrl && driveToken && getDriveSyncEnabled()) {
    syncConfig = {
      enabled: true,
      mode: 'drive',
      driveScriptUrl,
      driveToken,
      directPullSeconds: Math.max(1, Number.parseInt(
        getLocalConfigValue('directQueuePollSeconds', '', '10'),
        10
      ) || 10),
      cacheDir: getClientCacheBaseDir(),
    };
    return syncConfig;
  }
  const serverUrl = String(configStore?.get('serverUrl') || process.env.ERP_SERVER_URL || '').trim();
  const token = String(process.env.ERP_SERVER_TOKEN || configStore?.get('serverToken') || '').trim();
  syncConfig = {
    enabled: !!serverUrl && !!token,
    mode: 'lan',
    serverUrl,
    token,
    cacheDir: getClientCacheBaseDir(),
  };
  return syncConfig;
}

function stopSyncPolling() {
  if (!syncPollingTimer) return;
  clearTimeout(syncPollingTimer);
  syncPollingTimer = null;
}

async function disconnectSyncConnection(previousConfig = syncConfig, userName = activeLoginUser) {
  stopSyncPolling();
  // Wait for any pull/push that's already mid-flight to actually finish
  // before tearing down syncConfig. Without this, clicking Disconnect while
  // a sync cycle is running (downloading a snapshot, writing it into the
  // local database) doesn't stop that cycle at all — it just keeps running
  // in the background on its own, using the connection details that were
  // just supposedly disconnected, since nothing here ever waited for or
  // cancelled it. Bounded wait so a genuinely stuck operation can't hang
  // the disconnect button forever.
  const waitForInFlight = async () => {
    const deadline = Date.now() + 8000;
    while ((syncPullInFlight || syncPushQueueInFlight) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  await waitForInFlight();
  // The in-flight operation could have finished partway through the wait
  // above, and at that exact moment syncConfig.enabled was still true (we
  // haven't reset it yet) — its own completion logic checks that flag and
  // may have rescheduled a fresh polling timer right then, one that the
  // stopSyncPolling() call above never had a chance to see or cancel.
  // Stop it again now that we know nothing is still running.
  stopSyncPolling();
  if (previousConfig?.enabled && userName) {
    await releaseServerLoginSession(userName, previousConfig).catch(() => {});
  }
  syncConfig = {
    enabled: false,
    mode: '',
    serverUrl: '',
    driveScriptUrl: '',
    token: '',
    cacheDir: getClientCacheBaseDir(),
  };
  return { ok: true, waitedForInFlight: syncPullInFlight || syncPushQueueInFlight };
}

function getPendingSyncQueuePath() {
  return path.join(getClientCacheBaseDir(), 'pending-sync-queue.json');
}

function getDrivePendingQueuePath() {
  return path.join(getClientCacheBaseDir(), 'drive-pending-queue.json');
}

function readDrivePendingQueue() {
  const queuePath = getDrivePendingQueuePath();
  if (!fs.existsSync(queuePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeDrivePendingQueue(items = []) {
  const queuePath = getDrivePendingQueuePath();
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(Array.isArray(items) ? items.slice(-200) : [], null, 2), 'utf8');
}

function describeMutation(mutation = {}) {
  const table = String(mutation.table || 'change');
  const action = String(mutation.action || 'update');
  const data = mutation.data && typeof mutation.data === 'object' ? mutation.data : {};
  const label = data.task_title || data.title || data.project_name || data.issue_title || data.name || data.file_name || data.message || mutation.pkValue || '';
  return `${action} ${table}${label ? `: ${String(label).slice(0, 80)}` : ''}`;
}

function appendDrivePendingItems(actor, mutations = [], result = {}) {
  const existing = readDrivePendingQueue();
  const now = new Date().toISOString();
  const fileId = String(result.fileId || '');
  const additions = (mutations || []).map((mutation) => ({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    actor: String(actor || 'system'),
    table: String(mutation?.table || ''),
    action: String(mutation?.action || ''),
    label: describeMutation(mutation),
    queuedAt: now,
    fileId,
  }));
  writeDrivePendingQueue([...existing, ...additions]);
  return readDrivePendingQueue();
}

function getCurrentSyncQueueStatus(actor = activeLoginUser) {
  if (syncConfig?.enabled && syncConfig.mode === 'drive') {
    const pendingItems = readDrivePendingQueue();
    return { ok: true, drive: true, pendingCount: pendingItems.length, items: pendingItems, queueFile: getDrivePendingQueuePath() };
  }
  return { ok: true, pendingCount: readPendingSyncQueue().length, queueFile: getPendingSyncQueuePath() };
}

function broadcastSyncQueueStatus(status = getCurrentSyncQueueStatus()) {
  try {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) win.webContents.send('sync:queue-updated', status);
    });
  } catch {}
}

function readPendingSyncQueue() {
  const queuePath = getPendingSyncQueuePath();
  if (!fs.existsSync(queuePath)) return [];
  try {
    const rows = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function writePendingSyncQueue(queue) {
  const queuePath = getPendingSyncQueuePath();
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue || [], null, 2), 'utf8');
}

function enqueuePendingSync(actor, mutations, error = '') {
  const cleanMutations = Array.isArray(mutations) ? mutations.filter(Boolean) : [];
  if (!cleanMutations.length) return { pendingCount: readPendingSyncQueue().length };
  const queue = readPendingSyncQueue();
  queue.push({
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    actor: String(actor || 'system'),
    mutations: cleanMutations,
    queuedAt: new Date().toISOString(),
    lastError: String(error || ''),
  });
  writePendingSyncQueue(queue);
  return { pendingCount: queue.length };
}

async function flushPendingSyncQueue() {
  if (!syncConfig?.enabled || syncPushQueueInFlight) return { ok: true, skipped: true, pendingCount: readPendingSyncQueue().length };
  let queue = readPendingSyncQueue();
  if (!queue.length) return { ok: true, pendingCount: 0 };
  syncPushQueueInFlight = true;
  try {
    const remaining = [];
    for (const item of queue) {
      const mutations = Array.isArray(item?.mutations) ? item.mutations.filter(Boolean) : [];
      if (!mutations.length) continue;
      try {
        const actor = String(item.actor || 'system');
        if (syncConfig.mode === 'drive') {
          const result = await queueDriveMutations({
            driveScriptUrl: syncConfig.driveScriptUrl,
            driveToken: syncConfig.driveToken,
            actor,
            clientId: getClientInstanceId(),
            mutations,
          });
          appendDrivePendingItems(actor, mutations, result);
        } else {
          await pushMutations({
            ...syncConfig,
            actor,
            mutations,
          });
        }
      } catch (error) {
        remaining.push({
          ...item,
          lastError: String(error?.message || error),
          lastTriedAt: new Date().toISOString(),
        });
      }
    }
    writePendingSyncQueue(remaining);
    return { ok: remaining.length === 0, pendingCount: remaining.length };
  } finally {
    syncPushQueueInFlight = false;
  }
}

async function pullServerSnapshotIfEnabled(options = {}) {
  if (!syncConfig?.enabled || syncPullInFlight) return { ok: true, skipped: true };
  const forcePullBeforeQueue = !!options.forcePullBeforeQueue;
  syncPullInFlight = true;
  try {
    if (syncConfig.mode === 'drive') {
      const pendingBeforePull = await getDriveQueueStatus({
        driveScriptUrl: syncConfig.driveScriptUrl,
        driveToken: syncConfig.driveToken,
        actor: activeLoginUser || 'system',
        clientId: getClientInstanceId(),
      });
      if (!forcePullBeforeQueue && Number(pendingBeforePull?.pendingCount || 0) > 0) {
        const localPendingItems = readDrivePendingQueue();
        const pendingCount = Math.max(Number(pendingBeforePull.pendingCount || 0), localPendingItems.length);
        const queueStatus = {
          ok: true,
          drive: true,
          pendingCount,
          items: localPendingItems,
          waitingForServer: true,
        };
        broadcastSyncQueueStatus(queueStatus);
        return {
          ok: true,
          skipped: true,
          drive: true,
          pendingCount,
          waitingForServer: true,
          serverTime: '',
        };
      }
      const snapshot = await pullDriveSnapshotToLocalCache(syncConfig);
      const flushed = forcePullBeforeQueue ? await flushPendingSyncQueue() : { ok: true, pendingCount: 0, skipped: true };
      const pendingAfterPull = await getDriveQueueStatus({
        driveScriptUrl: syncConfig.driveScriptUrl,
        driveToken: syncConfig.driveToken,
        actor: activeLoginUser || 'system',
        clientId: getClientInstanceId(),
      });
      if (Number(pendingAfterPull?.pendingCount || 0) <= 0) writeDrivePendingQueue([]);
      const queueStatus = getCurrentSyncQueueStatus();
      const pendingCount = Math.max(
        Number(queueStatus.pendingCount || 0),
        Number(pendingAfterPull?.pendingCount || 0),
        Number(flushed?.pendingCount || 0)
      );
      try {
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('sync:snapshot-updated', { serverTime: snapshot?.serverTime || '', drive: true, pendingCount });
        });
      } catch {}
      broadcastSyncQueueStatus({ ...queueStatus, pendingCount });
      return {
        ok: !!flushed?.ok,
        serverTime: snapshot?.serverTime || '',
        drive: true,
        pendingCount,
        waitingForServer: pendingCount > 0,
        error: flushed?.ok === false ? 'Pending offline changes could not be pushed yet.' : '',
      };
    }
    const flushed = await flushPendingSyncQueue();
    if (!flushed.ok) {
      return { ok: false, pendingCount: flushed.pendingCount, error: 'Pending offline changes could not be pushed yet.' };
    }
    const snapshot = await pullSnapshotToLocalCache(syncConfig);
    console.log(`Pulled ERP server snapshot from ${syncConfig.serverUrl}`);
    try {
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('sync:snapshot-updated', { serverTime: snapshot?.serverTime || '' });
      });
    } catch {}
    return { ok: true, serverTime: snapshot?.serverTime || '' };
  } catch (error) {
    console.warn('ERP server snapshot pull failed; using local cache:', error?.message || error);
    return { ok: false, error: String(error?.message || error) };
  } finally {
    syncPullInFlight = false;
  }
}

async function registerServerLoginSession(userName, options = {}) {
  if (!syncConfig?.enabled) return { ok: true, skipped: true };
  const clientId = getClientInstanceId();
  try {
    const response = await fetch(`${String(syncConfig.serverUrl || '').replace(/\/$/, '')}/api/login-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${syncConfig.token}`,
      },
      body: JSON.stringify({
        user: String(userName || '').trim(),
        clientId,
        force: !!options.force,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) {
      return {
        ok: true,
        skipped: true,
        unsupported: true,
        warning: 'Connected ERP server does not support login-session checks yet.',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: true,
        skipped: true,
        unauthorized: true,
        warning: 'Server rejected the saved token for login-session checks.',
      };
    }
    if (!response.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.error || `Server login check failed: ${response.status}`,
        multipleSignIn: !!data?.multipleSignIn,
      };
    }
    return data;
  } catch (error) {
    return { ok: true, skipped: true, offline: true, warning: String(error?.message || error) };
  }
}

async function releaseServerLoginSession(userName, config = syncConfig) {
  if (!config?.enabled) return { ok: true, skipped: true };
  try {
    const clientId = getClientInstanceId();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${String(config.serverUrl || '').replace(/\/$/, '')}/api/login-session/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ user: String(userName || '').trim(), clientId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await response.json().catch(() => ({}));
    return response.ok && data?.ok ? data : { ok: false };
  } catch {
    return { ok: false };
  }
}

function getClientInstanceId() {
  const key = 'clientInstanceId';
  let id = String(configStore?.get(key) || '').trim();
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    configStore?.set(key, id);
  }
  return id;
}

function clearRemoteAttachmentPathsForClient(db) {
  if (!syncConfig?.enabled || !db) return;
  const localRoots = [
    getClientCacheBaseDir(),
    getDbBaseDir(),
    getInstallDir(),
  ].map(root => {
    try {
      return path.resolve(root).toLowerCase();
    } catch {
      return '';
    }
  }).filter(Boolean);
  const tables = ['task_attachments', 'task_comment_attachments', 'subtask_comment_attachments', 'issue_comment_attachments'];
  for (const table of tables) {
    try {
      const rows = db.prepare(`SELECT id, file_path FROM ${table} WHERE COALESCE(file_path, '') != ''`).all();
      const update = db.prepare(`UPDATE ${table} SET file_path='' WHERE id=?`);
      for (const row of rows) {
        const resolved = path.resolve(String(row.file_path || ''));
        const normalized = resolved.toLowerCase();
        const isLocal = localRoots.some(root => normalized === root || normalized.startsWith(`${root}${path.sep}`));
        if (!isLocal && !fs.existsSync(resolved)) {
          update.run(row.id);
        }
      }
    } catch {}
  }
}

function pushServerMutations(actor, mutations) {
  if (!syncConfig?.enabled || !Array.isArray(mutations) || !mutations.length) {
    return Promise.resolve({ ok: true, skipped: true });
  }
  const cleanActor = String(actor || 'system');
  if (syncConfig.mode === 'drive') {
    return queueDriveMutations({
      driveScriptUrl: syncConfig.driveScriptUrl,
      driveToken: syncConfig.driveToken,
      actor: cleanActor,
      clientId: getClientInstanceId(),
      mutations,
    }).then((result) => {
      const pendingItems = appendDrivePendingItems(cleanActor, mutations, result);
      const status = { ...result, pendingCount: pendingItems.length, items: pendingItems };
      broadcastSyncQueueStatus(status);
      return status;
    }).catch((error) => {
      console.warn('ERP Drive queue write failed:', error?.message || error);
      return { ok: false, queued: false, error: String(error?.message || error) };
    });
  }
  return flushPendingSyncQueue().then((flushed) => {
    if (!flushed.ok) {
      throw new Error('Pending offline changes could not be pushed yet.');
    }
    return pushMutations({
      ...syncConfig,
      actor: cleanActor,
      mutations,
    });
  }).catch((error) => {
    const queued = enqueuePendingSync(cleanActor, mutations, error?.message || error);
    console.warn('ERP server sync push failed:', error?.message || error);
    return { ok: false, queued: true, pendingCount: queued.pendingCount, error: String(error?.message || error) };
  });
}

function startSyncPollingIfEnabled() {
  if (RUN_AS_SERVER || syncPollingTimer || !syncConfig?.enabled) return;
  // Used to also call loadSyncConfig() here on every single cycle "just in
  // case" a setting changed — but every place that actually changes a
  // setting (config:app-settings:set) already calls loadSyncConfig()
  // itself right after writing it. Re-reading the config file from disk
  // again here added nothing but a recurring, indefinite read-touch on the
  // same file every cycle for as long as sync stays connected — exactly
  // the kind of repeated-access pattern that's worth not doing
  // unnecessarily on an unsigned executable that antivirus/EDR software
  // may be watching more closely than a one-off Save click.
  const delayMs = syncConfig.mode === 'drive'
    ? Math.max(1000, Number(syncConfig.directPullSeconds || 10) * 1000)
    : 5000;
  syncPollingTimer = setTimeout(async () => {
    syncPollingTimer = null;
    await pullServerSnapshotIfEnabled();
    if (syncConfig?.enabled) startSyncPollingIfEnabled();
  }, delayMs);
}

function mutationFromRow(table, pk, row, action = 'update') {
  return {
    table,
    action,
    pk,
    pkValue: row?.[pk],
    data: row || {},
    changedAt: new Date().toISOString(),
  };
}

function getDbStorageRootDir() {
  const dir = path.join(getRuntimeDbBaseDir(), 'DB');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function getAttachmentsDir() {
  const dir = path.join(getDbStorageRootDir(), 'attachments');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
function getAttachmentsBackupDir() {
  const dir = path.join(getDbStorageRootDir(), 'attachments-backup');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
function getAttachmentsArchiveDir() {
  const dir = path.join(getAttachmentsDir(), 'archive');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
function getPrimaryDbPath() {
  return path.join(getRuntimeDbBaseDir(), 'erp_tasks.db');
}
function getDbBackupPath() {
  return path.join(getDbStorageRootDir(), 'erp_tasks.backup.db');
}
function getAttachmentAuditLogPath() {
  return path.join(getDbStorageRootDir(), 'attachment-log.jsonl');
}
function ensureAttachmentStorageReady() {
  getAttachmentsDir();
  getAttachmentsBackupDir();
  getAttachmentsArchiveDir();
  const logPath = getAttachmentAuditLogPath();
  try {
    if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8');
  } catch {}
}
function ensureDatabaseAutoRestore() {
  if (RUN_AS_REMOTE) return;
  const dbPath = getPrimaryDbPath();
  const backupPath = getDbBackupPath();
  try {
    if (!fs.existsSync(dbPath) && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, dbPath);
      appendAttachmentAudit({
        action: 'database_restore',
        status: 'restored_from_backup',
        dbPath,
        backupPath,
      });
    }
  } catch (error) {
    appendAttachmentAudit({
      action: 'database_restore',
      status: 'restore_failed',
      dbPath,
      backupPath,
      error: String(error?.message || error),
    });
  }
}
function snapshotDatabaseBackup() {
  if (RUN_AS_REMOTE) return;
  const dbPath = getPrimaryDbPath();
  const backupPath = getDbBackupPath();
  try {
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupPath);
      appendAttachmentAudit({
        action: 'database_backup',
        status: 'ok',
        dbPath,
        backupPath,
      });
    }
  } catch (error) {
    appendAttachmentAudit({
      action: 'database_backup',
      status: 'failed',
      dbPath,
      backupPath,
      error: String(error?.message || error),
    });
  }
}
function appendAttachmentAudit(entry) {
  const fp = getAttachmentAuditLogPath();
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  }) + '\n';
  try {
    fs.appendFileSync(fp, payload, 'utf8');
  } catch {}
}
function readAttachmentAudit() {
  const fp = getAttachmentAuditLogPath();
  if (!fs.existsSync(fp)) return [];
  try {
    return fs.readFileSync(fp, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
function buildAttachmentRecoveryIndex() {
  const idx = new Map();
  for (const entry of readAttachmentAudit()) {
    const filePath = String(entry?.filePath || '').trim();
    if (!filePath) continue;
    if (entry.action === 'upload' || entry.action === 'startup_restore' || entry.action === 'archive_move') {
      idx.set(path.resolve(filePath), {
        backupPath: String(entry.backupPath || ''),
        fileHash: String(entry.fileHash || ''),
        actor: String(entry.uploadedBy || entry.restoredBy || ''),
        taskCreatedBy: String(entry.taskCreatedBy || ''),
        taskId: String(entry.taskId || ''),
      });
      continue;
    }
    if (entry.action === 'delete' && String(entry.status || '').toLowerCase() === 'deleted') {
      idx.delete(path.resolve(filePath));
    }
  }
  return idx;
}
function hashFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}
function resolveBackupPath(filePath, explicitBackupPath = '') {
  if (explicitBackupPath) return explicitBackupPath;
  return path.join(getAttachmentsBackupDir(), path.basename(filePath));
}
function restoreAttachmentFromBackup(filePath, backupPath, meta = {}) {
  try {
    if (!backupPath || !fs.existsSync(backupPath)) {
      return { ok: false, error: 'Backup file not found.' };
    }
    fs.copyFileSync(backupPath, filePath);
    const restoredHash = hashFileSha256(filePath);
    appendAttachmentAudit({
      action: 'startup_restore',
      status: 'restored',
      filePath,
      backupPath,
      fileHash: restoredHash,
      ...meta,
    });
    return { ok: true };
  } catch (error) {
    appendAttachmentAudit({
      action: 'startup_restore',
      status: 'restore_failed',
      filePath,
      backupPath,
      error: String(error?.message || error),
      ...meta,
    });
    return { ok: false, error: String(error?.message || error) };
  }
}
function resolveAttachmentContext(db, { itemId, isSubtask }) {
  const cleanItemId = String(itemId || '').trim();
  const context = {
    itemId: cleanItemId,
    isSubtask: !!isSubtask,
    entityType: isSubtask ? 'subtask' : 'task',
    taskId: '',
    taskName: '',
    projectId: '',
    projectName: '',
    taskCreatedBy: '',
    createdBy: '',
  };
  if (!cleanItemId) return context;
  try {
    if (isSubtask) {
      const row = db.prepare(`
        SELECT s.subtask_id, s.assigned_by AS subtask_created_by, s.task_id, t.assigned_by AS task_created_by,
               t.task_name, t.project_id, p.project_name
        FROM subtasks s
        LEFT JOIN tasks t ON t.task_id=s.task_id
        LEFT JOIN projects p ON p.project_id=t.project_id
        WHERE s.subtask_id=?
      `).get(cleanItemId);
      if (row) {
        context.taskId = String(row.task_id || '');
        context.taskName = String(row.task_name || '');
        context.projectId = String(row.project_id || '');
        context.projectName = String(row.project_name || '');
        context.taskCreatedBy = String(row.task_created_by || row.subtask_created_by || '');
        context.createdBy = String(row.subtask_created_by || '');
        return context;
      }
    }
    const taskRow = db.prepare(`
      SELECT t.task_id, t.task_name, t.assigned_by, t.project_id, p.project_name
      FROM tasks t
      LEFT JOIN projects p ON p.project_id=t.project_id
      WHERE t.task_id=?
    `).get(cleanItemId);
    if (taskRow) {
      context.entityType = 'task';
      context.taskId = String(taskRow.task_id || '');
      context.taskName = String(taskRow.task_name || '');
      context.projectId = String(taskRow.project_id || '');
      context.projectName = String(taskRow.project_name || '');
      context.taskCreatedBy = String(taskRow.assigned_by || '');
      context.createdBy = String(taskRow.assigned_by || '');
      return context;
    }
    const issueRow = db.prepare('SELECT issue_id, reported_by FROM issues WHERE issue_id=?').get(cleanItemId);
    if (issueRow) {
      context.entityType = 'issue';
      context.createdBy = String(issueRow.reported_by || '');
      return context;
    }
    const projectRow = db.prepare('SELECT project_id, created_by FROM projects WHERE project_id=?').get(cleanItemId);
    if (projectRow) {
      context.entityType = 'project';
      context.projectId = String(projectRow.project_id || '');
      context.createdBy = String(projectRow.created_by || '');
      context.projectName = String(projectRow.project_id || '');
      try {
        const nameRow = db.prepare('SELECT project_name FROM projects WHERE project_id=?').get(cleanItemId);
        context.projectName = String(nameRow?.project_name || context.projectName || '');
      } catch {}
      return context;
    }
  } catch {}
  return context;
}
function sanitizePathSegment(value, fallback = 'item') {
  const raw = String(value || '').trim();
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}
function buildAttachmentRelativeDir(meta = {}, { archived = false } = {}) {
  const entityType = String(meta.entityType || '').trim().toLowerCase();
  const itemId = sanitizePathSegment(meta.itemId || meta.taskId || meta.projectId || 'item', 'item');
  const taskId = sanitizePathSegment(meta.taskId || itemId, 'task');
  const subtaskId = sanitizePathSegment(meta.itemId || 'subtask', 'subtask');
  const issueId = sanitizePathSegment(meta.itemId || 'issue', 'issue');
  const projectName = sanitizePathSegment(meta.projectName || meta.projectId || '', '');
  const projectRoot = projectName ? ['projects', projectName] : [];
  let parts = ['misc'];
  if (entityType === 'project') parts = ['projects', sanitizePathSegment(meta.projectName || meta.itemId || 'project', 'project')];
  else if (entityType === 'task') parts = projectRoot.length ? [...projectRoot, 'tasks', taskId] : ['tasks', taskId];
  else if (entityType === 'subtask') parts = projectRoot.length ? [...projectRoot, 'tasks', taskId, 'subtasks', subtaskId] : ['tasks', taskId, 'subtasks', subtaskId];
  else if (entityType === 'task_comment') parts = projectRoot.length ? [...projectRoot, 'tasks', taskId, 'comments'] : ['tasks', taskId, 'comments'];
  else if (entityType === 'issue') parts = ['issues', issueId];
  else if (entityType === 'issue_comment') parts = ['issues', issueId, 'comments'];
  else if (entityType === 'recurring_template') parts = ['recurring-templates', sanitizePathSegment(meta.sourceTemplateId || 'template', 'template')];
  else if (entityType === 'sop') parts = ['sop', sanitizePathSegment(meta.rowId || meta.itemId || 'sop', 'sop')];
  if (archived) return path.join('archive', ...parts);
  return path.join(...parts);
}
function ensureUniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  let idx = 2;
  let candidate = `${base} (${idx})${ext}`;
  while (fs.existsSync(candidate)) {
    idx += 1;
    candidate = `${base} (${idx})${ext}`;
  }
  return candidate;
}
function removeStoredAttachmentFile(filePath, meta = {}) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  const insideManagedDir = resolved.startsWith(path.resolve(getAttachmentsDir()) + path.sep);
  const backupPath = resolveBackupPath(resolved, meta.backupPath);
  try {
    const existed = fs.existsSync(resolved);
    if (existed) fs.unlinkSync(resolved);
    try {
      if (backupPath && fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    } catch {}
    appendAttachmentAudit({
      action: 'delete',
      status: existed ? 'deleted' : 'missing_on_delete',
      filePath: resolved,
      backupPath,
      insideManagedDir,
      ...meta,
    });
  } catch (error) {
    appendAttachmentAudit({
      action: 'delete',
      status: 'delete_failed',
      filePath: resolved,
      backupPath,
      insideManagedDir,
      error: String(error?.message || error),
      ...meta,
    });
  }
}

function getActivityLogPath() {
  return path.join(getRuntimeDbBaseDir(), 'activity-log.jsonl');
}
function readActivityLog() {
  const fp = getActivityLogPath();
  if (!fs.existsSync(fp)) return [];
  try {
    const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
function writeActivityLog(entries) {
  const fp = getActivityLogPath();
  const payload = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
  fs.writeFileSync(fp, payload, 'utf8');
}
function appendActivity(entry) {
  const fp = getActivityLogPath();
  fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf8');
}

function copyToAttachments(fp, auditMeta = {}) {
  const sourcePath = path.resolve(String(fp || ''));
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`Attachment source not found: ${sourcePath || fp}`);
  }
  const relativeDir = buildAttachmentRelativeDir(auditMeta, { archived: false });
  const dir = path.join(getAttachmentsDir(), relativeDir);
  const backupDir = path.join(getAttachmentsBackupDir(), relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  const ext = path.extname(fp);
  const base = path.basename(fp, ext).replace(/[^a-z0-9_\- ]/gi, '').slice(0, 40) || 'file';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targetName = `${base}-${stamp}${ext}`;
  const targetPath = ensureUniqueFilePath(path.join(dir, targetName));
  const backupPath = ensureUniqueFilePath(path.join(backupDir, targetName));
  fs.copyFileSync(sourcePath, targetPath);
  fs.copyFileSync(sourcePath, backupPath);
  const fileHash = hashFileSha256(backupPath);
  appendAttachmentAudit({
    action: 'upload',
    sourcePath,
    filePath: targetPath,
    backupPath,
    fileHash,
    fileName: path.basename(fp),
    relativeDir,
    ...auditMeta,
  });
  return { fileName: path.basename(fp), filePath: targetPath, backupPath, fileHash };
}
function moveAttachmentToArchive(filePath, auditMeta = {}) {
  const sourcePath = path.resolve(String(filePath || ''));
  if (!sourcePath || !fs.existsSync(sourcePath)) return sourcePath;
  const archiveRoot = getAttachmentsArchiveDir();
  if (sourcePath.startsWith(path.resolve(archiveRoot) + path.sep)) return sourcePath;
  const relativeDir = buildAttachmentRelativeDir(auditMeta, { archived: true });
  const targetDir = path.join(getAttachmentsDir(), relativeDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const fileName = path.basename(sourcePath);
  const targetPath = ensureUniqueFilePath(path.join(targetDir, fileName));
  fs.renameSync(sourcePath, targetPath);
  appendAttachmentAudit({
    action: 'archive_move',
    status: 'moved',
    sourcePath,
    filePath: targetPath,
    fileName,
    relativeDir,
    ...auditMeta,
  });
  return targetPath;
}
function archiveTaskAttachments(db, taskId, actor = 'system') {
  const task = db.prepare(`
    SELECT t.task_id, t.task_name, t.assigned_by, t.project_id, p.project_name
    FROM tasks t
    LEFT JOIN projects p ON p.project_id=t.project_id
    WHERE t.task_id=?
  `).get(taskId);
  if (!task) return;
  const taskRows = db.prepare(`
    SELECT id, item_id, is_subtask, file_path
    FROM task_attachments
    WHERE item_id=? AND is_subtask=0
  `).all(taskId);
  const subtaskRows = db.prepare(`
    SELECT a.id, a.item_id, a.is_subtask, a.file_path, s.task_id
    FROM task_attachments a
    LEFT JOIN subtasks s ON s.subtask_id=a.item_id
    WHERE a.is_subtask=1 AND s.task_id=?
  `).all(taskId);
  const allRows = [...taskRows, ...subtaskRows];
  const updatePath = db.prepare('UPDATE task_attachments SET file_path=? WHERE id=?');
  for (const row of allRows) {
    if (!row?.file_path) continue;
    try {
      const context = resolveAttachmentContext(db, { itemId: row.item_id, isSubtask: !!row.is_subtask });
      const movedPath = moveAttachmentToArchive(row.file_path, {
        archivedBy: String(actor || '').trim() || 'system',
        taskId: String(task.task_id || taskId || ''),
        taskName: String(task.task_name || ''),
        taskCreatedBy: String(task.assigned_by || ''),
        createdBy: String(context.createdBy || task.assigned_by || ''),
        projectId: String(task.project_id || context.projectId || ''),
        projectName: String(task.project_name || context.projectName || ''),
        entityType: String(context.entityType || (row.is_subtask ? 'subtask' : 'task')),
        itemId: String(row.item_id || ''),
        rowId: row.id,
      });
      if (movedPath && movedPath !== row.file_path) {
        updatePath.run(movedPath, row.id);
      }
    } catch (error) {
      appendAttachmentAudit({
        action: 'archive_move',
        status: 'failed',
        filePath: String(row.file_path || ''),
        rowId: row.id,
        taskId: String(taskId || ''),
        error: String(error?.message || error),
      });
    }
  }
}

function getClipboardStageDir() {
  const dir = path.join(app.getPath('temp'), 'erp-clipboard-stage');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function fileExtFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('bmp')) return '.bmp';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('zip')) return '.zip';
  if (mime.includes('csv')) return '.csv';
  if (mime.includes('word')) return '.docx';
  if (mime.includes('excel') || mime.includes('spreadsheet')) return '.xlsx';
  if (mime.includes('text')) return '.txt';
  return '';
}

function stageClipboardFile({ name, type, dataBase64 }) {
  const stageDir = getClipboardStageDir();
  const inputName = (name || '').trim();
  const inputExt = path.extname(inputName);
  const ext = inputExt || fileExtFromMime(type) || '.bin';
  const base = (path.basename(inputName || `clipboard-${Date.now()}`, inputExt || ext) || 'clipboard')
    .replace(/[^a-z0-9_\- ]/gi, '')
    .slice(0, 40) || 'clipboard';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(stageDir, `${base}-${stamp}${ext}`);
  fs.writeFileSync(filePath, Buffer.from(dataBase64 || '', 'base64'));
  return filePath;
}

function parseAttachmentPaths(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function persistTemplateAttachmentPaths(filePaths, auditMeta = {}) {
  if (!Array.isArray(filePaths)) return [];
  const attachmentsDir = path.resolve(getAttachmentsDir());
  const keep = [];
  for (const fp of filePaths) {
    if (!fp || typeof fp !== 'string') continue;
    try {
      const resolved = path.resolve(fp);
      if (resolved.startsWith(attachmentsDir + path.sep) && fs.existsSync(resolved)) {
        keep.push(resolved);
      } else if (fs.existsSync(resolved)) {
        const stored = copyToAttachments(resolved, auditMeta);
        keep.push(stored.filePath);
      }
    } catch {}
  }
  return [...new Set(keep)];
}

function cleanupTemplateAttachmentFiles(oldPaths, keepPaths = []) {
  const keep = new Set(keepPaths || []);
  for (const fp of oldPaths || []) {
    if (!fp || keep.has(fp)) continue;
    removeStoredAttachmentFile(fp, { scope: 'recurring_template_cleanup' });
  }
}

function collectAttachmentReferences(db) {
  const refs = [];
  const taskRows = db.prepare('SELECT id, item_id, is_subtask, file_path FROM task_attachments').all();
  for (const row of taskRows) {
    const context = resolveAttachmentContext(db, { itemId: row.item_id, isSubtask: !!row.is_subtask });
    refs.push({
      table: 'task_attachments',
      rowId: row.id,
      filePath: row.file_path || '',
      itemId: row.item_id || '',
      entityType: context.entityType || (row.is_subtask ? 'subtask' : 'task'),
      taskId: context.taskId || '',
      taskCreatedBy: context.taskCreatedBy || '',
      createdBy: context.createdBy || '',
    });
  }
  const commentRows = db.prepare(`
    SELECT a.id, a.file_path, c.task_id, c.author, t.assigned_by AS task_created_by
    FROM task_comment_attachments a
    LEFT JOIN task_comments c ON c.id=a.comment_id
    LEFT JOIN tasks t ON t.task_id=c.task_id
  `).all();
  for (const row of commentRows) {
    refs.push({
      table: 'task_comment_attachments',
      rowId: row.id,
      filePath: row.file_path || '',
      entityType: 'task_comment',
      taskId: row.task_id || '',
      taskCreatedBy: row.task_created_by || '',
      createdBy: row.author || '',
    });
  }
  const subtaskCommentRows = db.prepare(`
    SELECT a.id, a.file_path, c.subtask_id, c.author, s.task_id, s.assigned_by AS subtask_created_by, t.assigned_by AS task_created_by
    FROM subtask_comment_attachments a
    LEFT JOIN subtask_comments c ON c.id=a.comment_id
    LEFT JOIN subtasks s ON s.subtask_id=c.subtask_id
    LEFT JOIN tasks t ON t.task_id=s.task_id
  `).all();
  for (const row of subtaskCommentRows) {
    refs.push({
      table: 'subtask_comment_attachments',
      rowId: row.id,
      filePath: row.file_path || '',
      itemId: row.subtask_id || '',
      entityType: 'subtask_comment',
      taskId: row.task_id || '',
      taskCreatedBy: row.task_created_by || row.subtask_created_by || '',
      createdBy: row.author || '',
    });
  }
  const issueCommentRows = db.prepare(`
    SELECT a.id, a.file_path, c.issue_id, c.author, i.reported_by
    FROM issue_comment_attachments a
    LEFT JOIN issue_comments c ON c.id=a.comment_id
    LEFT JOIN issues i ON i.issue_id=c.issue_id
  `).all();
  for (const row of issueCommentRows) {
    refs.push({
      table: 'issue_comment_attachments',
      rowId: row.id,
      filePath: row.file_path || '',
      itemId: row.issue_id || '',
      entityType: 'issue_comment',
      createdBy: row.author || '',
      taskCreatedBy: row.reported_by || '',
    });
  }
  const sopRows = db.prepare("SELECT sop_id, attachment_path, assigned_by FROM sops WHERE COALESCE(attachment_path,'') != ''").all();
  for (const row of sopRows) {
    refs.push({
      table: 'sops',
      rowId: row.sop_id,
      filePath: row.attachment_path || '',
      entityType: 'sop',
      createdBy: row.assigned_by || '',
    });
  }
  const recurringRows = db.prepare("SELECT id, attachment_paths, assigned_by FROM recurring_tasks WHERE COALESCE(attachment_paths,'') != ''").all();
  for (const row of recurringRows) {
    const paths = parseAttachmentPaths(row.attachment_paths);
    for (const fp of paths) {
      refs.push({
        table: 'recurring_tasks',
        rowId: row.id,
        filePath: fp || '',
        entityType: 'recurring_template',
        taskCreatedBy: row.assigned_by || '',
        createdBy: row.assigned_by || '',
      });
    }
  }
  return refs.filter(r => !!r.filePath);
}

function verifyAttachmentIntegrity(db) {
  ensureAttachmentStorageReady();
  const recoveryIndex = buildAttachmentRecoveryIndex();
  const refs = collectAttachmentReferences(db);
  const notRecovered = [];
  for (const ref of refs) {
    try {
      const resolved = path.resolve(ref.filePath);
      const recoveryMeta = recoveryIndex.get(resolved) || {};
      const backupPath = resolveBackupPath(resolved, recoveryMeta.backupPath);
      if (!fs.existsSync(resolved)) {
        const restored = restoreAttachmentFromBackup(resolved, backupPath, {
          table: ref.table,
          rowId: ref.rowId,
          taskId: recoveryMeta.taskId || ref.taskId || '',
          taskCreatedBy: recoveryMeta.taskCreatedBy || ref.taskCreatedBy || '',
          createdBy: ref.createdBy || '',
          entityType: ref.entityType || '',
          itemId: ref.itemId || '',
          restoredBy: 'system',
        });
        if (!restored.ok) {
          notRecovered.push({ ...ref, filePath: resolved, backupPath, reason: restored.error || 'Missing file.' });
        }
        continue;
      }
      if (recoveryMeta.fileHash) {
        try {
          const currentHash = hashFileSha256(resolved);
          if (String(currentHash) !== String(recoveryMeta.fileHash)) {
            const restored = restoreAttachmentFromBackup(resolved, backupPath, {
              table: ref.table,
              rowId: ref.rowId,
              taskId: recoveryMeta.taskId || ref.taskId || '',
              taskCreatedBy: recoveryMeta.taskCreatedBy || ref.taskCreatedBy || '',
              createdBy: ref.createdBy || '',
              entityType: ref.entityType || '',
              itemId: ref.itemId || '',
              restoredBy: 'system',
              reason: 'hash_mismatch',
            });
            if (!restored.ok) {
              notRecovered.push({ ...ref, filePath: resolved, backupPath, reason: restored.error || 'Corrupted file.' });
            }
          }
        } catch (hashError) {
          notRecovered.push({ ...ref, filePath: resolved, backupPath, reason: String(hashError?.message || hashError) });
        }
      }
    } catch {
      notRecovered.push(ref);
    }
  }
  if (!notRecovered.length) return;
  for (const miss of notRecovered) {
    appendAttachmentAudit({
      action: 'startup_verify_missing',
      table: miss.table,
      rowId: miss.rowId,
      filePath: miss.filePath,
      backupPath: miss.backupPath || '',
      reason: miss.reason || '',
      taskId: miss.taskId || '',
      taskCreatedBy: miss.taskCreatedBy || '',
      createdBy: miss.createdBy || '',
      entityType: miss.entityType || '',
      itemId: miss.itemId || '',
      restoredBy: 'system',
    });
  }
  const preview = notRecovered.slice(0, 8).map(m => `${m.table}:${m.rowId} -> ${m.filePath}`).join('\n');
  const suffix = notRecovered.length > 8 ? `\n...and ${notRecovered.length - 8} more.` : '';
  dialog.showErrorBox(
    'Attachment Verification Error',
    `Error! File not found.\n\nMissing attachment record(s): ${notRecovered.length}\n\n${preview}${suffix}`
  );
}
function seedAttachmentBackupsFromDb(db) {
  ensureAttachmentStorageReady();
  const refs = collectAttachmentReferences(db);
  for (const ref of refs) {
    try {
      const resolved = path.resolve(ref.filePath);
      if (!fs.existsSync(resolved)) continue;
      const backupPath = resolveBackupPath(resolved);
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(resolved, backupPath);
        appendAttachmentAudit({
          action: 'backup_seed',
          status: 'created',
          filePath: resolved,
          backupPath,
          fileHash: hashFileSha256(backupPath),
          taskId: ref.taskId || '',
          taskCreatedBy: ref.taskCreatedBy || '',
          createdBy: ref.createdBy || '',
          entityType: ref.entityType || '',
          itemId: ref.itemId || '',
        });
      }
    } catch {}
  }
}

function normalizeTeamName(value) {
  return String(value || '').replace(/\u00a0/g, ' ').trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password || ''), String(salt || ''), 120000, 64, 'sha512').toString('hex');
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  return hashPassword(password, salt) === String(hash);
}

function getWindowState() {
  if (!windowStateStore) return { width: 1280, height: 820 };
  return {
    width: windowStateStore.get('width', 1280),
    height: windowStateStore.get('height', 820),
    x: windowStateStore.get('x'),
    y: windowStateStore.get('y'),
    isMaximized: windowStateStore.get('isMaximized', false),
  };
}

function saveWindowState(win) {
  if (!windowStateStore || !win) return;
  const isMaximized = win.isMaximized();
  if (!isMaximized) {
    const bounds = win.getBounds();
    windowStateStore.set('width', bounds.width);
    windowStateStore.set('height', bounds.height);
    windowStateStore.set('x', bounds.x);
    windowStateStore.set('y', bounds.y);
  }
  windowStateStore.set('isMaximized', isMaximized);
}

function getTrayImage() {
  const candidates = [
    path.join(__dirname, 'App.ico'),
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'task_manager_icon_light.svg'),
    path.join(__dirname, 'dist', 'task_manager_icon_light.svg'),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16, quality: 'best' });
    } catch {}
  }
  return null;
}

function showMainWindow() {
  if (RUN_AS_SERVER) {
    if (!serverWindow || serverWindow.isDestroyed()) {
      createServerManagerWindow();
      return;
    }
    if (serverWindow.isMinimized()) serverWindow.restore();
    serverWindow.show();
    serverWindow.focus();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function refreshTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: `Open ${getAppDisplayName()}`, click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: 'Run On Startup',
      type: 'checkbox',
      checked: getAutoLaunchSetting(),
      click: (item) => { setAutoLaunch(!!item.checked); },
    },
    { type: 'separator' },
    {
      label: `Exit ${getAppDisplayName()}`,
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray) return;
  const trayImage = getTrayImage();
  if (!trayImage) return;
  tray = new Tray(trayImage);
  tray.setToolTip(getAppDisplayName());
  tray.on('double-click', () => showMainWindow());
  tray.on('click', () => showMainWindow());
  refreshTrayMenu();
}

function registerServerIpcHandlers() {
  if (!managedServer) return;
  ipcMain.handle('server:status', () => managedServer.getServerStatus());
  ipcMain.handle('server:start', async (_event, options) => managedServer.startServer(options));
  ipcMain.handle('server:stop', async () => managedServer.stopServer());
  ipcMain.handle('server:logs', () => managedServer.getServerLogs());
  ipcMain.handle('server:remote-access:get', () => managedServer.getRemoteAccessConfig());
  ipcMain.handle('server:remote-access:set', (_event, data = {}) => managedServer.setRemoteAccessConfig(data || {}));
  ipcMain.handle('server:backups:list', () => ({ ok: true, backups: listServerBackups() }));
  ipcMain.handle('server:backups:create', () => createServerBackup());
  ipcMain.handle('server:backups:restore', async (_event, { id }) => restoreServerBackup(id));
  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog(serverWindow || undefined, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths || [])[0];
  });
  ipcMain.handle('shell:open-path', (_event, target) => {
    if (!target) return;
    shell.openPath(target);
  });
  ipcMain.handle('config:db-path:get', () => getConfiguredDataDir());
  ipcMain.handle('config:db-path:set', (_event, { path: newPath }) => {
    return setConfiguredDataDir(newPath);
  });
  managedServer.onServerLog((entry) => {
    if (serverWindow && !serverWindow.isDestroyed()) {
      serverWindow.webContents.send('server:log', entry);
    }
  });
}

function createServerManagerWindow() {
  if (serverWindow && !serverWindow.isDestroyed()) {
    serverWindow.show();
    serverWindow.focus();
    return;
  }
  serverWindow = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    title: 'ERP Server Manager',
    icon: path.join(__dirname, 'App.ico'),
    backgroundColor: '#f4f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const html = `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>ERP Server Manager</title>
    <style>
      body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #f4f7fa; color: #0f172a; }
      header { height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; background: #fff; border-bottom: 1px solid #e2e8f0; }
      h1 { margin: 0; font-size: 18px; }
      main { padding: 24px; display: grid; gap: 18px; }
      .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; }
      .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      .grid { display: grid; grid-template-columns: 170px 1fr; gap: 10px 16px; font-size: 13px; }
      .label { color: #64748b; }
      .value { font-weight: 600; word-break: break-all; }
      .dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; margin-right: 8px; }
      button { border: 1px solid #cbd5e1; background: #fff; color: #0f172a; border-radius: 8px; padding: 9px 13px; font-weight: 700; cursor: pointer; }
      button.primary { background: #0f9f6e; border-color: #0f9f6e; color: #fff; }
      button.danger { background: #dc2626; border-color: #dc2626; color: #fff; }
      button:disabled { opacity: .55; cursor: not-allowed; }
      select { border: 1px solid #cbd5e1; border-radius: 8px; padding: 9px 12px; min-width: 280px; background: #fff; color: #0f172a; font-weight: 600; }
      pre { margin: 0; height: 250px; overflow: auto; background: #0f172a; color: #dbeafe; border-radius: 8px; padding: 12px; font-size: 12px; line-height: 1.45; white-space: pre-wrap; }
      .muted { color: #64748b; font-size: 12px; }
      .tabbar { display: flex; gap: 8px; }
      .tab { border-radius: 999px; padding: 8px 14px; }
      .tab.active { background: #0d9488; border-color: #0d9488; color: #fff; }
      .remote-tab-card { display: none; }
      body.remote-tab .server-tab-card { display: none; }
      body.remote-tab .remote-tab-card { display: block; }
      input { border: 1px solid #cbd5e1; border-radius: 8px; padding: 9px 12px; background: #fff; color: #0f172a; font-weight: 600; }
      .dialog-backdrop { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(15,23,42,.45); backdrop-filter: blur(4px); z-index: 20; }
      .dialog-backdrop.open { display: flex; }
      .dialog-card { width: min(420px, calc(100vw - 32px)); background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 24px 70px rgba(15,23,42,.24); padding: 24px; }
      .dialog-head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 20px; }
      .dialog-icon { width: 42px; height: 42px; border-radius: 10px; background: #fee2e2; color: #dc2626; display: grid; place-items: center; font-weight: 900; flex: 0 0 auto; }
      .dialog-title { margin: 0 0 5px; font-size: 16px; font-weight: 800; color: #0f172a; }
      .dialog-message { margin: 0; color: #64748b; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
      .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .card-title-row { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
      .card-desc { color: #64748b; font-size: 12.5px; margin: 0 0 14px; line-height: 1.5; }
      .copy-btn { padding: 5px 10px; font-size: 11.5px; font-weight: 600; }
      .copy-btn.copied { background: #0d9488; border-color: #0d9488; color: #fff; }
      .status-pill { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 700; padding: 4px 10px; border-radius: 999px; }
      .status-pill.ok { background: #f0fdf4; color: #166534; }
      .status-pill.off { background: #f1f5f9; color: #64748b; }
      .field-row { display: flex; align-items: center; gap: 8px; }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>ERP Server Manager</h1>
        <div class="muted" style="margin-top:2px;">Runs the shared database that every Client and Remote Access device connects to.</div>
      </div>
      <div id="badge" class="muted">Checking...</div>
    </header>
    <main>
      <div class="tabbar">
        <button id="serverTabBtn" class="tab active">LAN Server</button>
        <button id="remoteTabBtn" class="tab">Remote Access (Drive)</button>
      </div>
      <section class="card server-tab-card">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div id="statusText" style="font-weight:800;font-size:16px;">Loading...</div>
            <div id="statusSub" class="muted"></div>
          </div>
          <div class="row">
            <button id="startBtn" class="primary">Start Server</button>
            <button id="stopBtn" class="danger">Stop Server</button>
            <button id="refreshBtn">Refresh</button>
          </div>
        </div>
        <p class="card-desc" style="margin-top:12px;margin-bottom:0;">Client devices on the same network can only sync while this is running. It's safe to leave running in the background.</p>
      </section>
      <section class="card server-tab-card">
        <h2 style="font-size:15px;margin:0 0 4px;">Configuration</h2>
        <p class="card-desc">Give the Client Token below to anyone setting up a Client device they'll paste it into that device's connection settings along with the LAN URL.</p>
        <div class="grid">
          <div class="label">LAN URLs</div><div id="lanUrls" class="value">-</div>
          <div class="label">Port</div><div id="port" class="value">-</div>
          <div class="label">Database Folder</div><div id="dbDir" class="value">-</div>
          <div class="label">Token File</div><div id="tokenFile" class="value">-</div>
          <div class="label">Client Token</div>
          <div class="field-row"><div id="token" class="value">-</div><button id="copyTokenBtn" class="copy-btn">Copy</button></div>
        </div>
        <div class="row" style="margin-top:14px;">
          <button id="openDbBtn">Open Database Folder</button>
          <button id="changeDbBtn">Change Database Folder</button>
          <button id="openTokenBtn">Open Token Folder</button>
        </div>
        <div id="dbChangeMsg" class="muted" style="margin-top:10px;"></div>
      </section>
      <section class="card server-tab-card">
        <h2 style="font-size:15px;margin:0 0 4px;">Backups</h2>
        <p class="card-desc">A backup is a complete, point-in-time copy of the database, attachments, and logs â€” useful before making a risky change, or on a regular schedule for safety.</p>
        <div class="row">
          <button id="createBackupBtn" class="primary">Create Backup</button>
          <select id="backupSelect">
            <option value="">No backups found</option>
          </select>
          <button id="restoreBackupBtn" class="danger">Restore from Backup</button>
          <button id="refreshBackupsBtn">Refresh Backups</button>
        </div>
        <div class="muted" style="margin-top:10px;">
          Backups are saved inside the current database folder under <b>server-backups</b>. Each backup folder is named by backup date and includes the database, logs, attachments, and related data files.
        </div>
        <div id="backupMsg" class="muted" style="margin-top:10px;"></div>
      </section>
      <section class="card remote-tab-card">
        <div class="card-title-row">
          <h2 style="font-size:15px;margin:0;">Remote Access (Drive)</h2>
          <span id="driveStatusPill" class="status-pill off">Not connected</span>
        </div>
        <p class="card-desc">Remote Access devices read and write through a Google Apps Script web app, which relays changes via a Google Drive file. This server checks that relay on a timer, applies any changes to its own database, then publishes a fresh copy back to Drive for everyone else.</p>
        <div class="grid">
          <div class="label">Drive Script URL</div><div id="remoteDriveScriptUrl" class="value">-</div>
          <div class="label">Drive Token</div><div id="remoteDriveTokenStatus" class="value">-</div>
          <div class="label">Check For Updates Every</div>
          <div><input id="remoteQueuePollSeconds" type="number" min="1" style="width:90px;" /> <span class="muted">seconds â€” how often this server checks Drive for new changes</span></div>
          <div class="label">Apps Script Web App URL</div>
          <div><input id="remoteDriveScriptInput" type="text" placeholder="https://script.google.com/macros/s/.../exec" /></div>
          <div class="label">Apps Script Token</div>
          <div><input id="remoteDriveTokenInput" type="password" placeholder="Token from Apps Script" /></div>
        </div>
        <div class="row" style="margin-top:14px;">
          <button id="saveRemoteAccessBtn" class="primary">Save Remote Access Settings</button>
          <button id="refreshRemoteAccessBtn">Refresh</button>
        </div>
        <div id="remoteAccessMsg" class="muted" style="margin-top:10px;"></div>
      </section>
      <section class="card server-tab-card">
        <div class="row" style="justify-content:space-between;margin-bottom:6px;">
          <h2 style="font-size:15px;margin:0;">Logs</h2>
          <button id="reloadLogsBtn">Reload Logs</button>
        </div>
        <p class="card-desc">A running record of server activity â€” startups, connections, sync checks, and errors. Useful for diagnosing a connection problem.</p>
        <pre id="logs"></pre>
      </section>
    </main>
    <div id="confirmDialog" class="dialog-backdrop">
      <div class="dialog-card">
        <div class="dialog-head">
          <div class="dialog-icon">!</div>
          <div>
            <h3 id="confirmTitle" class="dialog-title">Confirm</h3>
            <p id="confirmMessage" class="dialog-message"></p>
          </div>
        </div>
        <div class="dialog-actions">
          <button id="confirmCancel">Cancel</button>
          <button id="confirmOk" class="primary">Create</button>
        </div>
      </div>
    </div>
    <script>
      let status = null;
      let promptedConflictKey = '';
      let confirmResolver = null;
      const $ = (id) => document.getElementById(id);
      const fmt = (entry) => '[' + new Date(entry.ts).toLocaleString() + '] ' + entry.level.toUpperCase() + ' ' + entry.message;
      function showConfirm({ title, message, confirmLabel }) {
        $('confirmTitle').textContent = title || 'Confirm';
        $('confirmMessage').textContent = message || '';
        $('confirmOk').textContent = confirmLabel || 'OK';
        $('confirmDialog').classList.add('open');
        return new Promise(resolve => { confirmResolver = resolve; });
      }
      function closeConfirm(value) {
        $('confirmDialog').classList.remove('open');
        if (confirmResolver) confirmResolver(value);
        confirmResolver = null;
      }
      function setLogs(rows) {
        $('logs').textContent = (rows || []).map(fmt).join('\\n');
        $('logs').scrollTop = $('logs').scrollHeight;
      }
      function render(next) {
        status = next || {};
        const running = !!status.running;
        $('badge').innerHTML = '<span class="dot" style="background:' + (running ? '#22c55e' : '#ef4444') + '"></span>' + (running ? 'Running' : 'Stopped');
        $('statusText').textContent = running ? 'Server is running' : 'Server is stopped';
        $('statusSub').textContent = status.error ? status.error : (running && status.startedAt ? 'Started ' + new Date(status.startedAt).toLocaleString() : '');
        $('startBtn').disabled = running;
        $('stopBtn').disabled = !running;
        $('lanUrls').textContent = (status.lanUrls || []).join('   ') || 'No LAN address detected';
        $('port').textContent = status.port || '-';
        $('dbDir').textContent = status.dbDir || '-';
        $('tokenFile').textContent = status.tokenFile || '-';
        $('token').textContent = status.token || '-';
        if ($('remoteDriveScriptUrl')) $('remoteDriveScriptUrl').textContent = status.driveScriptUrl || '-';
        if ($('remoteDriveTokenStatus')) $('remoteDriveTokenStatus').textContent = status.driveTokenConfigured ? 'Configured' : 'Not configured';
        if ($('remoteDriveScriptInput')) $('remoteDriveScriptInput').value = status.driveScriptUrl || '';
        if ($('remoteDriveTokenInput')) $('remoteDriveTokenInput').value = status.driveToken || $('remoteDriveTokenInput').value || '';
        if ($('remoteQueuePollSeconds')) $('remoteQueuePollSeconds').value = status.directQueuePollSeconds || 10;
        setDriveStatusPill(!!status.driveScriptUrl && !!status.driveTokenConfigured);
        maybePromptForNewServer(status);
      }
      function setDriveStatusPill(connected) {
        const pill = $('driveStatusPill');
        if (!pill) return;
        pill.className = 'status-pill ' + (connected ? 'ok' : 'off');
        pill.textContent = connected ? 'Configured & relaying' : 'Not connected';
      }
      function setTab(tab) {
        const remote = tab === 'remote';
        document.body.classList.toggle('remote-tab', remote);
        $('serverTabBtn').classList.toggle('active', !remote);
        $('remoteTabBtn').classList.toggle('active', remote);
        if (remote) loadRemoteAccess();
      }
      async function loadRemoteAccess() {
        const res = await window.electronAPI.server.getRemoteAccess();
        if (!res?.ok) return;
        if ($('remoteDriveScriptUrl')) $('remoteDriveScriptUrl').textContent = res.driveScriptUrl || '-';
        if ($('remoteDriveTokenStatus')) $('remoteDriveTokenStatus').textContent = res.driveTokenConfigured ? 'Configured' : 'Not configured';
        if ($('remoteDriveScriptInput')) $('remoteDriveScriptInput').value = res.driveScriptUrl || '';
        if ($('remoteDriveTokenInput')) $('remoteDriveTokenInput').value = res.driveToken || $('remoteDriveTokenInput').value || '';
        if ($('remoteQueuePollSeconds')) $('remoteQueuePollSeconds').value = res.directQueuePollSeconds || 10;
        setDriveStatusPill(!!res.driveScriptUrl && !!res.driveTokenConfigured);
      }
      function backupLabel(row) {
        const dt = row.createdAt ? new Date(row.createdAt) : null;
        const when = dt && !Number.isNaN(dt.getTime()) ? dt.toLocaleString() : (row.folderName || row.id || 'Backup');
        const restored = row.restoredAt ? ' | restored ' + new Date(row.restoredAt).toLocaleString() : '';
        return when + restored;
      }
      function renderBackups(rows) {
        const backups = rows || [];
        $('backupSelect').innerHTML = '';
        if (!backups.length) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No backups found';
          $('backupSelect').appendChild(opt);
          $('restoreBackupBtn').disabled = true;
          return;
        }
        for (const row of backups) {
          const opt = document.createElement('option');
          opt.value = row.id || row.folderName || '';
          opt.textContent = backupLabel(row);
          opt.title = row.path || '';
          $('backupSelect').appendChild(opt);
        }
        $('restoreBackupBtn').disabled = false;
      }
      async function loadBackups() {
        const res = await window.electronAPI.server.listBackups();
        renderBackups(res?.backups || []);
        return res?.backups || [];
      }
      async function startServer(options) {
        const nextStatus = await window.electronAPI.server.start(options || {});
        render(nextStatus);
        reloadLogs();
        return nextStatus;
      }
      function maybePromptForNewServer(nextStatus) {
        if (!nextStatus?.portConflict || !nextStatus.suggestedPort) return;
        const conflictKey = String(nextStatus.port || '') + ':' + String(nextStatus.suggestedPort || '') + ':' + String(nextStatus.error || '');
        if (promptedConflictKey === conflictKey) return;
        promptedConflictKey = conflictKey;
        setTimeout(async () => {
          const message = (nextStatus.error || 'Server port already exists.') + '\\n\\nCreate new server on port ' + nextStatus.suggestedPort + '?';
          const accepted = await showConfirm({ title: 'Server Port Already Exists', message, confirmLabel: 'Create Server' });
          if (!accepted) return;
          await startServer({ port: nextStatus.suggestedPort });
        }, 50);
      }
      async function refresh() {
        render(await window.electronAPI.server.status());
      }
      async function reloadLogs() {
        setLogs(await window.electronAPI.server.logs());
      }
      $('startBtn').onclick = async () => { await startServer(); };
      $('stopBtn').onclick = async () => { render(await window.electronAPI.server.stop()); reloadLogs(); };
      $('refreshBtn').onclick = refresh;
      $('serverTabBtn').onclick = () => setTab('server');
      $('remoteTabBtn').onclick = () => setTab('remote');
      $('reloadLogsBtn').onclick = reloadLogs;
      $('refreshRemoteAccessBtn').onclick = async () => {
        $('remoteAccessMsg').textContent = 'Refreshing remote access settings...';
        await loadRemoteAccess();
        $('remoteAccessMsg').textContent = 'Remote access settings refreshed.';
      };
      $('saveRemoteAccessBtn').onclick = async () => {
        $('remoteAccessMsg').textContent = 'Saving remote access settings...';
        $('saveRemoteAccessBtn').disabled = true;
        const res = await window.electronAPI.server.setRemoteAccess({
          pollSeconds: $('remoteQueuePollSeconds').value,
          driveScriptUrl: $('remoteDriveScriptInput')?.value || '',
          driveToken: $('remoteDriveTokenInput')?.value || '',
        });
        $('saveRemoteAccessBtn').disabled = false;
        if (res?.ok) {
          await loadRemoteAccess();
          refresh();
          $('remoteAccessMsg').textContent = 'Remote access settings saved.';
        } else {
          $('remoteAccessMsg').textContent = res?.error || 'Unable to save remote access settings.';
        }
      };
      $('refreshBackupsBtn').onclick = async () => {
        $('backupMsg').textContent = 'Refreshing backups...';
        await loadBackups();
        $('backupMsg').textContent = 'Backup list refreshed.';
      };
      $('createBackupBtn').onclick = async () => {
        $('backupMsg').textContent = 'Creating backup...';
        $('createBackupBtn').disabled = true;
        const res = await window.electronAPI.server.createBackup();
        $('createBackupBtn').disabled = false;
        if (res?.ok) {
          renderBackups(res.backups || []);
          $('backupMsg').textContent = 'Backup created: ' + (res.backup?.folderName || res.backup?.id || '');
        } else {
          $('backupMsg').textContent = res?.error || 'Unable to create backup.';
        }
      };
      $('restoreBackupBtn').onclick = async () => {
        const id = $('backupSelect').value;
        if (!id) return;
        const selectedText = $('backupSelect').selectedOptions[0]?.textContent || id;
        const accepted = await showConfirm({
          title: 'Restore Backup',
          message: 'Restore this backup?\\n\\n' + selectedText + '\\n\\nThe server will stop, the current DB folder contents will be replaced, and then the server will restart.',
          confirmLabel: 'Restore',
        });
        if (!accepted) return;
        $('backupMsg').textContent = 'Restoring backup...';
        $('restoreBackupBtn').disabled = true;
        const res = await window.electronAPI.server.restoreBackup({ id });
        $('restoreBackupBtn').disabled = false;
        if (res?.ok) {
          render(res.status);
          renderBackups(res.backups || []);
          reloadLogs();
          $('backupMsg').textContent = 'Restored backup: ' + (res.restored?.folderName || res.restored?.id || '');
        } else {
          $('backupMsg').textContent = res?.error || 'Unable to restore backup.';
          refresh();
        }
      };
      $('openDbBtn').onclick = () => status?.dbDir && window.electronAPI.openPath(status.dbDir);
      $('confirmCancel').onclick = () => closeConfirm(false);
      $('confirmOk').onclick = () => closeConfirm(true);
      $('changeDbBtn').onclick = async () => {
        const selected = await window.electronAPI.selectFolder();
        if (!selected) return;
        const res = await window.electronAPI.config.setDbPath({ path: selected });
        $('dbChangeMsg').textContent = res?.ok
          ? 'Database folder updated. Exit from tray and reopen the server to use the new folder.'
          : (res?.error || 'Unable to update database folder.');
        refresh();
      };
      $('openTokenBtn').onclick = () => status?.tokenFile && window.electronAPI.openPath(status.tokenFile.replace(/\\\\[^\\\\]+$/, ''));
      $('copyTokenBtn').onclick = async () => {
        const token = status?.token || '';
        if (!token) return;
        try {
          await navigator.clipboard.writeText(token);
          const btn = $('copyTokenBtn');
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
        } catch {}
      };
      window.electronAPI.server.onLog((entry) => {
        $('logs').textContent += ($('logs').textContent ? '\\n' : '') + fmt(entry);
        $('logs').scrollTop = $('logs').scrollHeight;
        refresh();
      });
      refresh();
      reloadLogs();
      loadBackups();
    </script>
  </body>
  </html>`;
  serverWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  serverWindow.on('unresponsive', () => {
    writeCrashLog('server-window-unresponsive', null);
  });
  serverWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    writeCrashLog('server-window-did-fail-load', null, { errorCode, errorDescription, validatedURL });
  });
  serverWindow.on('close', (event) => {
    if (isQuitting) return;
    if (!getBooleanSetting('minimizeToTray', true)) return;
    if (!tray) return;
    event.preventDefault();
    serverWindow.hide();
    if (process.platform === 'win32' && !getBooleanSetting('trayHintShown', false)) {
      try {
        tray.displayBalloon({
          title: 'Task Manager Server',
          content: 'Task Manager Server is still running in the system tray.',
        });
      } catch {}
      configStore?.set('trayHintShown', true);
    }
  });
  serverWindow.on('closed', () => {
    serverWindow = null;
  });
}

function createWindow() {
  const state = getWindowState();

  mainWindow = new BrowserWindow({
    width: Math.max(800, state.width),
    height: Math.max(600, state.height),
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    title: getAppDisplayName(),
    icon: path.join(__dirname, 'App.ico'),
    backgroundColor: '#f4f7fa',
    show: false,                    // show after ready-to-show
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  // Restore maximized state
  if (state.isMaximized) {
    mainWindow.maximize();
  }

  // Graceful show
  mainWindow.once('ready-to-show', () => {
    if (launchedAtLogin && getBooleanSetting('minimizeToTray', true) && tray) {
      mainWindow.hide();
      return;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  // Save state on resize / move
  ['resize', 'move'].forEach((evt) => {
    mainWindow.on(evt, () => saveWindowState(mainWindow));
  });

  mainWindow.on('close', (event) => {
    saveWindowState(mainWindow);
    if (isQuitting) return;
    if (!getBooleanSetting('minimizeToTray', true)) return;
    if (!tray) return;
    event.preventDefault();
    mainWindow.hide();
    if (process.platform === 'win32' && !getBooleanSetting('trayHintShown', false)) {
      try {
        tray.displayBalloon({
          title: getAppDisplayName(),
          content: `${getAppDisplayName()} is still running in the system tray.`,
        });
      } catch {}
      configStore?.set('trayHintShown', true);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('unresponsive', () => {
    writeCrashLog('main-window-unresponsive', null);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    writeCrashLog('main-window-did-fail-load', null, { errorCode, errorDescription, validatedURL });
  });

  // Connection Mode card on the Settings page reads RUN_AS_REMOTE via the
  // connection:get-mode IPC call and renders accordingly, so there's no
  // need for a second HTML/JS bundle keyed off mode. remote.html/
  // src/remote-main.jsx are no longer loaded here. Confirmed safe to
  // delete: remote-main.jsx's only job was rendering <App mode="remote" />,
  // which src/client-main.jsx now does dynamically via connection:get-mode-sync
  // (see registerIpcHandlers()).
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Export Tasks (CSV)',
          accelerator: 'CmdOrCtrl+E',
          click: () => mainWindow?.webContents.send('menu:export-csv'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${getAppDisplayName()}`,
          click: showAboutDialog,
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function registerIpcHandlers() {
  // Synchronous channel used only at renderer bootstrap, before first paint,
  // so main.jsx can pass `mode="remote"` into <App> exactly like
  // instead of from loading a second HTML/JS bundle. Everything else about
  // connection mode (status, switching) goes through the async
  // connection:get-mode / connection:set-mode handlers below.
  ipcMain.on('connection:get-mode-sync', (event) => {
    event.returnValue = RUN_AS_REMOTE ? 'remote' : 'client';
  });

  const db = getDatabase();
  const hasColumn = (table, column) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    } catch {
      return false;
    }
  };
  const employeeTeamCol = hasColumn('employees', 'team_name') ? 'team_name' : (hasColumn('employees', 'team') ? 'team' : '');
  const employeeRoleCol = hasColumn('employees', 'role') ? 'role' : (hasColumn('employees', 'designation') ? 'designation' : '');
  const employeePasswordHashCol = hasColumn('employees', 'password_hash') ? 'password_hash' : '';
  const employeePasswordSaltCol = hasColumn('employees', 'password_salt') ? 'password_salt' : '';
  const projectTeamCol = hasColumn('projects', 'team_name') ? 'team_name' : (hasColumn('projects', 'team') ? 'team' : '');
  const readTeamNames = (table, teamCol) => {
    if (!teamCol) return [];
    return db.prepare(`SELECT ${teamCol} AS team_name FROM ${table} WHERE trim(COALESCE(${teamCol},'')) <> ''`).all().map(r => r.team_name);
  };
  const uniqueNonEmpty = (arr) => [...new Set((arr || []).map(v => String(v || '').trim()).filter(Boolean))];
  const splitMultiValue = (value) => String(value || '').split(',').map(v => v.trim()).filter(Boolean);
  const hasMultiValue = (value, target) => {
    const cleanTarget = String(target || '').trim().toLowerCase();
    return !!cleanTarget && splitMultiValue(value).some(v => v.toLowerCase() === cleanTarget);
  };
  const roleExpr = employeeRoleCol ? `COALESCE(${employeeRoleCol}, '${BASE_ROLE}')` : `'${BASE_ROLE}'`;
  const teamExpr = employeeTeamCol ? `COALESCE(${employeeTeamCol}, '')` : "''";
  const resolveProjectAudience = (projectId) => {
    const pid = String(projectId || '').trim();
    if (!pid) return [];
    const p = db.prepare('SELECT owner_name, team_name FROM projects WHERE project_id=?').get(pid);
    if (!p) return [];
    const users = [];
    users.push(...splitMultiValue(p.owner_name));
    const teamNames = splitMultiValue(p.team_name).map(v => v.toLowerCase());
    if (teamNames.length && employeeTeamCol) {
      const teamUsers = db.prepare(`SELECT name, ${employeeTeamCol} AS team_name FROM employees WHERE trim(COALESCE(${employeeTeamCol}, '')) <> ''`).all()
        .filter(r => teamNames.includes(String(r.team_name || '').trim().toLowerCase()))
        .map(r => r.name);
      users.push(...teamUsers);
    }
    return uniqueNonEmpty(users);
  };
  const resolveTaskAudience = (taskId) => {
    const tid = String(taskId || '').trim();
    if (!tid) return [];
    const t = db.prepare('SELECT assigned_to, assigned_by, project_id FROM tasks WHERE task_id=?').get(tid);
    if (!t) return [];
    return uniqueNonEmpty([t.assigned_to, t.assigned_by, ...resolveProjectAudience(t.project_id)]);
  };
  const resolveApproversForTask = (taskRow) => {
    const admins = db.prepare(`SELECT name FROM employees WHERE lower(${roleExpr}) IN ('superadmin','admin')`).all().map(r => r.name);
    return uniqueNonEmpty([taskRow?.assigned_by, ...admins]);
  };
  const getUserRoleByName = (userName) => {
    const name = String(userName || '').trim();
    if (!name) return '';
    const row = db.prepare(`SELECT ${roleExpr} AS role FROM employees WHERE lower(name)=lower(?) LIMIT 1`).get(name);
    return String(row?.role || '').trim().toLowerCase();
  };
  const isSuperAdminRoleName = (role) => String(role || '').trim().toLowerCase() === String(SUPERADMIN_ROLE || 'Superadmin').toLowerCase();
  const isSuperAdminRole = (userName) => isSuperAdminRoleName(getUserRoleByName(userName));
  const isAdminRoleName = (role) => ['admin', 'superadmin'].includes(String(role || '').trim().toLowerCase());
  const isAdminRole = (userName) => isAdminRoleName(getUserRoleByName(userName));
  const isDirectorRole = (userName) => ['director', 'directors'].includes(String(getUserRoleByName(userName) || '').trim().toLowerCase());
  const isSystemAdminUserName = (userName) => String(userName || '').trim().toLowerCase() === SYSTEM_ADMIN_NAME.toLowerCase();
  const isBaseUserRoleName = (role) => ['employee', 'executive'].includes(String(role || '').trim().toLowerCase());
  const isPrivilegedRole = (userName) => ['superadmin', 'admin', 'manager'].includes(getUserRoleByName(userName));
  const getAppSetting = (key, fallback = '') => {
    try {
      const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
      if (!row) return fallback;
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  };
  const setAppSetting = (key, value) => {
    db.prepare(`
      INSERT INTO app_settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, JSON.stringify(value));
  };
  const nextDefaultTaskId = () => 'T' + Math.random().toString(36).substr(2, 6).toUpperCase();
  const generateTaskId = () => {
    const prefix = String(getAppSetting('taskIdPrefix', '') || '').trim();
    let nextNumber = Number.parseInt(String(getAppSetting('taskIdNextNumber', '') || ''), 10);
    if (!prefix || !Number.isFinite(nextNumber) || nextNumber < 1) return nextDefaultTaskId();
    let id = '';
    do {
      id = `${prefix}${nextNumber}`;
      nextNumber += 1;
    } while (db.prepare('SELECT task_id FROM tasks WHERE task_id=?').get(id));
    setAppSetting('taskIdNextNumber', String(nextNumber));
    return id;
  };
  const canSeeTask = (taskId, actor, isAdminFlag = false) => {
    const actorName = String(actor || '').trim();
    if (!taskId) return false;
    const task = db.prepare('SELECT assigned_to, assigned_by FROM tasks WHERE task_id=?').get(taskId);
    if (!task) return false;
    const normalized = actorName.toLowerCase();
    const assignedTo = String(task.assigned_to || '').trim().toLowerCase();
    const assignedBy = String(task.assigned_by || '').trim().toLowerCase();
    if (assignedTo && assignedTo === assignedBy && assignedTo !== normalized) return false;
    if (isAdminFlag || isPrivilegedRole(actorName)) return true;
    if ([task.assigned_to, task.assigned_by].map(v => String(v || '').trim().toLowerCase()).includes(normalized)) return true;
    const subtask = db.prepare("SELECT subtask_id FROM subtasks WHERE task_id=? AND lower(COALESCE(assigned_to, ''))=lower(?) LIMIT 1").get(taskId, actorName);
    return !!subtask;
  };
  const canSeeAttachmentItem = (itemId, isSubtask, actor, isAdminFlag = false) => {
    const actorName = String(actor || '').trim();
    if (!itemId) return false;
    if (!isSubtask) {
      const task = db.prepare('SELECT task_id FROM tasks WHERE task_id=?').get(itemId);
      if (task) return canSeeTask(itemId, actorName, isAdminFlag);
      const issue = db.prepare('SELECT reported_by, assigned_to FROM issues WHERE issue_id=?').get(itemId);
      if (issue) {
        if (isAdminFlag || isPrivilegedRole(actorName)) return true;
        const normalized = actorName.toLowerCase();
        return [issue.reported_by, issue.assigned_to].map(v => String(v || '').trim().toLowerCase()).includes(normalized);
      }
      const project = db.prepare('SELECT project_id FROM projects WHERE project_id=?').get(itemId);
      if (project) {
        if (isAdminFlag || isPrivilegedRole(actorName)) return true;
        return resolveProjectAudience(itemId).map(v => String(v || '').trim().toLowerCase()).includes(actorName.toLowerCase());
      }
      return false;
    }
    const subtask = db.prepare(`
      SELECT s.subtask_id, s.assigned_to, t.task_id, t.assigned_to AS task_assigned_to, t.assigned_by AS task_assigned_by
      FROM subtasks s
      LEFT JOIN tasks t ON t.task_id=s.task_id
      WHERE s.subtask_id=?
    `).get(itemId);
    if (!subtask) return false;
    if (canSeeTask(subtask.task_id, actorName, isAdminFlag)) return true;
    const normalized = actorName.toLowerCase();
    return [subtask.assigned_to, subtask.task_assigned_to, subtask.task_assigned_by]
      .map(v => String(v || '').trim().toLowerCase())
      .includes(normalized);
  };
  const hydrateAttachmentRows = async (table, rows, actor, isAdminFlag = false) => {
    for (const row of rows || []) {
      if (row?.file_path && fs.existsSync(row.file_path)) continue;
      if (!syncConfig?.enabled) continue;
      try {
        const localPath = await downloadAttachmentFile(db, syncConfig.serverUrl, syncConfig.token, syncConfig.cacheDir, table, row, {
          actor,
          isAdmin: !!isAdminFlag || isPrivilegedRole(actor),
        });
        if (localPath) row.file_path = localPath;
      } catch (error) {
        console.warn('Attachment download skipped:', error?.message || error);
      }
    }
    return rows || [];
  };
  const logTaskHistory = ({ taskId, actor, action, summary, details }) => {
    if (!taskId) return;
    db.prepare(`
      INSERT INTO task_history (task_id, changed_on, changed_by, action, summary, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(taskId),
      formatDateTime(new Date()),
      String(actor || 'system'),
      String(action || 'update'),
      String(summary || ''),
      JSON.stringify(details || {})
    );
  };
  const fetchRowByPk = (table, pk, value) => db.prepare(`SELECT * FROM ${table} WHERE ${pk}=?`).get(value);
  const syncRowByPk = (actor, table, pk, value, action = 'update') => {
    const row = fetchRowByPk(table, pk, value);
    if (!row && action !== 'delete') return Promise.resolve({ ok: true, skipped: true });
    return pushServerMutations(actor || 'system', [
      action === 'delete'
        ? { table, action: 'delete', pk, pkValue: value, data: { [pk]: value }, changedAt: new Date().toISOString() }
        : mutationFromRow(table, pk, row, action),
    ]);
  };

  ipcMain.handle('db:employees:list', () => {
    ensureSystemAdmin(db);
    const teamExpr = employeeTeamCol ? `COALESCE(${employeeTeamCol}, '')` : "''";
    const roleExpr = employeeRoleCol ? `COALESCE(${employeeRoleCol}, '${BASE_ROLE}')` : `'${BASE_ROLE}'`;
    return db.prepare(`SELECT name, ${roleExpr} AS role, ${teamExpr} AS team FROM employees ORDER BY name`).all();
  });

  ipcMain.handle('db:employees:add', async (_e, { name, role, team, actor }) => {
    const userName = (name || '').trim();
    const requestedRole = String(role || BASE_ROLE).trim() || BASE_ROLE;
    if (!userName) return { ok: false, error: 'Name is required.' };
    if (userName.toLowerCase() === SYSTEM_ADMIN_NAME.toLowerCase()) return { ok: false, error: 'Built-in Admin is reserved and cannot be added.' };
    if (isSuperAdminRoleName(requestedRole)) {
      return { ok: false, error: 'Only the built-in Admin user can have Superadmin role.' };
    }
    if (requestedRole.toLowerCase() === 'admin' && !isAdminRole(actor)) {
      return { ok: false, error: 'Only Admin can add another Admin.' };
    }
    const exists = db.prepare("SELECT name FROM employees WHERE lower(name)=lower(?)").get(userName);
    if (exists) return { ok: false, error: 'User already exist' };
    try {
      const defaultSalt = crypto.randomBytes(16).toString('hex');
      const defaultHash = hashPassword(DEFAULT_USER_PASSWORD, defaultSalt);
      if (employeeTeamCol) {
        if (employeeRoleCol) {
          if (employeePasswordHashCol && employeePasswordSaltCol) {
            db.prepare(`INSERT INTO employees(name, ${employeeRoleCol}, ${employeeTeamCol}, ${employeePasswordHashCol}, ${employeePasswordSaltCol}) VALUES(?, ?, ?, ?, ?)`).run(
              userName,
              requestedRole,
              (team || '').trim(),
              defaultHash,
              defaultSalt
            );
          } else {
            db.prepare(`INSERT INTO employees(name, ${employeeRoleCol}, ${employeeTeamCol}) VALUES(?, ?, ?)`).run(
              userName,
              requestedRole,
              (team || '').trim()
            );
          }
        } else {
          if (employeePasswordHashCol && employeePasswordSaltCol) {
            db.prepare(`INSERT INTO employees(name, ${employeeTeamCol}, ${employeePasswordHashCol}, ${employeePasswordSaltCol}) VALUES(?, ?, ?, ?)`).run(
              userName,
              (team || '').trim(),
              defaultHash,
              defaultSalt
            );
          } else {
            db.prepare(`INSERT INTO employees(name, ${employeeTeamCol}) VALUES(?, ?)`).run(
              userName,
              (team || '').trim()
            );
          }
        }
      } else {
        if (employeeRoleCol) {
          if (employeePasswordHashCol && employeePasswordSaltCol) {
            db.prepare(`INSERT INTO employees(name, ${employeeRoleCol}, ${employeePasswordHashCol}, ${employeePasswordSaltCol}) VALUES(?, ?, ?, ?)`).run(
              userName,
              requestedRole,
              defaultHash,
              defaultSalt
            );
          } else {
            db.prepare(`INSERT INTO employees(name, ${employeeRoleCol}) VALUES(?, ?)`).run(
              userName,
              requestedRole
            );
          }
        } else {
          if (employeePasswordHashCol && employeePasswordSaltCol) {
            db.prepare(`INSERT INTO employees(name, ${employeePasswordHashCol}, ${employeePasswordSaltCol}) VALUES(?, ?, ?)`).run(
              userName,
              defaultHash,
              defaultSalt
            );
          } else {
            db.prepare('INSERT INTO employees(name) VALUES(?)').run(userName);
          }
        }
      }
      appendActivity({
        id: 'N' + Math.random().toString(36).substr(2, 9),
        ts: formatDateTime(new Date()),
        title: `Employee added: ${userName}`,
        message: `Role: ${requestedRole}. Team: ${(team || '').trim() || 'None'}.`,
        actor: String(actor || 'system'),
        recipients: [],
        eventType: 'employee_add',
      });
      const sync = await syncRowByPk(actor || 'system', 'employees', 'name', userName, 'insert');
      return { ok: true, name: userName, sync };
    } catch (e) {
      return { ok: false, error: e?.message || 'Unable to add employee.' };
    }
  });

  ipcMain.handle('db:employees:update', async (_e, payload) => {
    const oldName = String(payload.oldName || payload.name || '').trim();
    const newName = String(payload.newName || payload.name || '').trim();
    const role = String(payload.role || BASE_ROLE).trim();
    const team = String(payload.team || '').trim();
    if (!oldName) return { ok: false, error: 'Employee not found.' };
    if (!newName) return { ok: false, error: 'Name is required.' };
    if (
      oldName.toLowerCase() === SYSTEM_ADMIN_NAME.toLowerCase() ||
      newName.toLowerCase() === SYSTEM_ADMIN_NAME.toLowerCase()
    ) {
      ensureSystemAdmin(db);
      return { ok: false, error: 'Built-in Admin cannot be modified.' };
    }

    const existing = db.prepare('SELECT name FROM employees WHERE name=?').get(oldName);
    if (!existing) return { ok: false, error: 'Employee not found.' };
    const oldRole = getUserRoleByName(oldName);
    if (isSuperAdminRoleName(role) || isSuperAdminRoleName(oldRole)) {
      ensureSystemAdmin(db);
      return { ok: false, error: 'Only the built-in Admin user can have Superadmin role.' };
    }
    const actorRole = getUserRoleByName(payload.actor);
    const roleChanged = oldRole !== role.toLowerCase();
    const adminRoleInvolved = role.toLowerCase() === 'admin' || oldRole === 'admin';
    const nonAdminRoleInvolved = ['manager', 'executive', 'employee'].includes(role.toLowerCase()) || ['manager', 'executive', 'employee'].includes(oldRole);
    if ((role.toLowerCase() === 'admin' || oldRole === 'admin') && !isAdminRole(payload.actor)) {
      return { ok: false, error: 'Only Admin can add or modify Admin users.' };
    }
    if (roleChanged && !adminRoleInvolved && nonAdminRoleInvolved) {
      if (!['admin', 'manager'].includes(actorRole)) return { ok: false, error: 'Only Admins or Managers can change Manager/Executive roles.' };
      if (actorRole === 'manager' && String(payload.actor || '').trim().toLowerCase() === oldName.toLowerCase()) {
        return { ok: false, error: 'Managers cannot change their own role.' };
      }
    }

    if (newName.toLowerCase() !== oldName.toLowerCase()) {
      const taken = db.prepare("SELECT name FROM employees WHERE lower(name)=lower(?)").get(newName);
      if (taken) return { ok: false, error: 'User already exist' };
    }

    if (employeeTeamCol && employeeRoleCol) {
      db.prepare(`UPDATE employees SET name=?, ${employeeRoleCol}=?, ${employeeTeamCol}=? WHERE name=?`).run(newName, role, team, oldName);
    } else if (employeeRoleCol) {
      db.prepare(`UPDATE employees SET name=?, ${employeeRoleCol}=? WHERE name=?`).run(newName, role, oldName);
    } else if (employeeTeamCol) {
      db.prepare(`UPDATE employees SET name=?, ${employeeTeamCol}=? WHERE name=?`).run(newName, team, oldName);
    } else {
      db.prepare('UPDATE employees SET name=? WHERE name=?').run(newName, oldName);
    }
    appendActivity({
      id: 'N' + Math.random().toString(36).substr(2, 9),
      ts: formatDateTime(new Date()),
      title: `Employee updated: ${oldName}`,
      message: `Updated as ${newName}.`,
      actor: String(payload.actor || 'system'),
      recipients: [],
      eventType: 'employee_update',
    });
    const mutations = [];
    if (newName.toLowerCase() !== oldName.toLowerCase()) {
      mutations.push({ table: 'employees', action: 'delete', pk: 'name', pkValue: oldName, data: { name: oldName }, changedAt: new Date().toISOString() });
    }
    const row = fetchRowByPk('employees', 'name', newName);
    if (row) mutations.push(mutationFromRow('employees', 'name', row, newName.toLowerCase() !== oldName.toLowerCase() ? 'insert' : 'update'));
    const sync = await pushServerMutations(payload.actor || 'system', mutations);
    return { ok: true, name: newName, sync };
  });

  ipcMain.handle('db:employees:delete', async (_e, { name, actor }) => {
    if (String(name || '').trim().toLowerCase() === SYSTEM_ADMIN_NAME.toLowerCase()) {
      ensureSystemAdmin(db);
      return { ok: false, error: 'Built-in Admin cannot be deleted.' };
    }
    db.prepare('DELETE FROM employees WHERE name=?').run(name);
    appendActivity({
      id: 'N' + Math.random().toString(36).substr(2, 9),
      ts: formatDateTime(new Date()),
      title: `Employee deleted: ${name}`,
      message: `Removed from user list.`,
      actor: String(actor || 'system'),
      recipients: [],
      eventType: 'employee_delete',
    });
    const sync = await syncRowByPk(actor || 'system', 'employees', 'name', name, 'delete');
    return { ok: true, sync };
  });

  ipcMain.handle('auth:login', async (_e, { name, password, force }) => {
    const userName = String(name || '').trim();
    const rawPassword = String(password || '');
    if (!userName) return { ok: false, error: 'User is required.' };
    if (!rawPassword) return { ok: false, error: 'Password is required.' };

    const roleExpr = employeeRoleCol ? `COALESCE(${employeeRoleCol}, '${BASE_ROLE}')` : `'${BASE_ROLE}'`;
    const teamExpr = employeeTeamCol ? `COALESCE(${employeeTeamCol}, '')` : "''";
    const hashExpr = employeePasswordHashCol ? `COALESCE(${employeePasswordHashCol}, '')` : "''";
    const saltExpr = employeePasswordSaltCol ? `COALESCE(${employeePasswordSaltCol}, '')` : "''";
    const row = db.prepare(`
      SELECT name, ${roleExpr} AS role, ${teamExpr} AS team,
             ${hashExpr} AS password_hash, ${saltExpr} AS password_salt
      FROM employees
      WHERE lower(name)=lower(?)
      LIMIT 1
    `).get(userName);
    if (!row) return { ok: false, error: 'Invalid user or password.' };

    let hash = String(row.password_hash || '');
    let salt = String(row.password_salt || '');
    if (!hash || !salt) {
      salt = crypto.randomBytes(16).toString('hex');
      hash = hashPassword(DEFAULT_USER_PASSWORD, salt);
      if (employeePasswordHashCol && employeePasswordSaltCol) {
        db.prepare(`UPDATE employees SET ${employeePasswordHashCol}=?, ${employeePasswordSaltCol}=? WHERE name=?`).run(hash, salt, row.name);
      }
    }
    if (!verifyPassword(rawPassword, hash, salt)) {
      return { ok: false, error: 'Invalid user or password.' };
    }
    const session = await registerServerLoginSession(row.name, { force });
    if (!session?.ok && session?.multipleSignIn) {
      return {
        ok: false,
        multipleSignIn: true,
        error: 'Multiple sign-in detected. This user is already signed in on another client. Use here?',
      };
    }
    if (!session?.ok) {
      return { ok: false, error: session?.error || 'Server login check failed.' };
    }
    activeLoginUser = row.name;
    const isDefaultPassword = verifyPassword(DEFAULT_USER_PASSWORD, hash, salt);
    const hintRow = db.prepare(`
      SELECT value FROM user_settings
      WHERE user_name=? AND key='default_password_hint_seen'
      LIMIT 1
    `).get(row.name);
    const hintSeen = String(hintRow?.value || '') === '1';
    const showDefaultPasswordHint = isDefaultPassword && !hintSeen;
    if (showDefaultPasswordHint) {
      db.prepare(`
        INSERT INTO user_settings(user_name, key, value)
        VALUES(?, 'default_password_hint_seen', '1')
        ON CONFLICT(user_name, key) DO UPDATE SET value=excluded.value
      `).run(row.name);
    }
    const mutations = [];
    if (!String(row.password_hash || '') || !String(row.password_salt || '')) {
      const updatedEmployee = fetchRowByPk('employees', 'name', row.name);
      if (updatedEmployee) mutations.push(mutationFromRow('employees', 'name', updatedEmployee, 'update'));
    }
    if (showDefaultPasswordHint) {
      const settingRow = db.prepare(`
        SELECT user_name, key, value
        FROM user_settings
        WHERE user_name=? AND key='default_password_hint_seen'
      `).get(row.name);
      if (settingRow) {
        mutations.push({
          table: 'user_settings',
          action: 'update',
          pk: ['user_name', 'key'],
          pkValue: [settingRow.user_name, settingRow.key],
          data: settingRow,
          changedAt: new Date().toISOString(),
        });
      }
    }
    await pushServerMutations(row.name, mutations);
    return { ok: true, user: { name: row.name, role: row.role, team: row.team }, isDefaultPassword, showDefaultPasswordHint };
  });

  ipcMain.handle('auth:logout', async (_e, { name } = {}) => {
    const userName = String(name || activeLoginUser || '').trim();
    if (userName) await releaseServerLoginSession(userName);
    if (!name || String(name || '').trim().toLowerCase() === String(activeLoginUser || '').trim().toLowerCase()) {
      activeLoginUser = '';
    }
    return { ok: true };
  });

  ipcMain.handle('auth:isDefaultPassword', (_e, { name }) => {
    const userName = String(name || '').trim();
    if (!userName) return { ok: false, error: 'User is required.' };
    const hashExpr = employeePasswordHashCol ? `COALESCE(${employeePasswordHashCol}, '')` : "''";
    const saltExpr = employeePasswordSaltCol ? `COALESCE(${employeePasswordSaltCol}, '')` : "''";
    const row = db.prepare(`
      SELECT name, ${hashExpr} AS password_hash, ${saltExpr} AS password_salt
      FROM employees
      WHERE lower(name)=lower(?)
      LIMIT 1
    `).get(userName);
    if (!row) return { ok: false, error: 'User not found.' };
    const hash = String(row.password_hash || '');
    const salt = String(row.password_salt || '');
    const isDefaultPassword = (!hash || !salt) ? true : verifyPassword(DEFAULT_USER_PASSWORD, hash, salt);
    const hintRow = db.prepare(`
      SELECT value FROM user_settings
      WHERE user_name=? AND key='default_password_hint_seen'
      LIMIT 1
    `).get(row.name);
    const hintSeen = String(hintRow?.value || '') === '1';
    return { ok: true, isDefaultPassword, showDefaultPasswordHint: isDefaultPassword && !hintSeen };
  });

  ipcMain.handle('auth:remember:get', () => {
    const remembered = configStore?.get('rememberLogin');
    if (!remembered || typeof remembered !== 'object') return { ok: true, data: null };
    return {
      ok: true,
      data: {
        name: String(remembered.name || ''),
        password: String(remembered.password || ''),
        remember: !!remembered.remember,
      },
    };
  });

  ipcMain.handle('auth:remember:set', (_e, payload) => {
    const data = {
      name: String(payload?.name || ''),
      password: String(payload?.password || ''),
      remember: !!payload?.remember,
    };
    if (configStore) configStore.set('rememberLogin', data);
    return { ok: true };
  });

  ipcMain.handle('auth:remember:clear', () => {
    if (configStore) configStore.delete('rememberLogin');
    return { ok: true };
  });

  ipcMain.handle('auth:changePassword', async (_e, { name, currentPassword, newPassword }) => {
    const userName = String(name || '').trim();
    const oldPass = String(currentPassword || '');
    const nextPass = String(newPassword || '');
    if (!userName) return { ok: false, error: 'User is required.' };
    if (!oldPass) return { ok: false, error: 'Current password is required.' };
    if (!nextPass) return { ok: false, error: 'New password is required.' };
    if (nextPass.length < 5) return { ok: false, error: 'Password must be at least 5 characters.' };
    if (!employeePasswordHashCol || !employeePasswordSaltCol) return { ok: false, error: 'Password columns are not configured.' };

    const row = db.prepare(`
      SELECT name, COALESCE(${employeePasswordHashCol}, '') AS password_hash, COALESCE(${employeePasswordSaltCol}, '') AS password_salt
      FROM employees
      WHERE lower(name)=lower(?)
      LIMIT 1
    `).get(userName);
    if (!row) return { ok: false, error: 'User not found.' };

    let currentHash = String(row.password_hash || '');
    let currentSalt = String(row.password_salt || '');
    if (!currentHash || !currentSalt) {
      currentSalt = crypto.randomBytes(16).toString('hex');
      currentHash = hashPassword(DEFAULT_USER_PASSWORD, currentSalt);
      db.prepare(`UPDATE employees SET ${employeePasswordHashCol}=?, ${employeePasswordSaltCol}=? WHERE name=?`).run(currentHash, currentSalt, row.name);
    }
    if (!verifyPassword(oldPass, currentHash, currentSalt)) {
      return { ok: false, error: 'Current password is incorrect.' };
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(nextPass, salt);
    db.prepare(`UPDATE employees SET ${employeePasswordHashCol}=?, ${employeePasswordSaltCol}=? WHERE name=?`).run(hash, salt, row.name);
    const sync = await syncRowByPk(row.name, 'employees', 'name', row.name, 'update');
    return { ok: true, sync };
  });

  ipcMain.handle('db:teams:list', () => {
    const unionParts = [
      `
        SELECT trim(replace(team_name, char(160), ' ')) AS team_name, COALESCE(lead_name, '') AS lead_name
        FROM teams
        WHERE trim(COALESCE(team_name, '')) <> ''
      `,
    ];
    if (employeeTeamCol) {
      unionParts.push(`
        SELECT trim(replace(${employeeTeamCol}, char(160), ' ')) AS team_name, '' AS lead_name
        FROM employees
        WHERE trim(COALESCE(${employeeTeamCol}, '')) <> ''
      `);
    }
    if (projectTeamCol) {
      unionParts.push(`
        SELECT trim(replace(${projectTeamCol}, char(160), ' ')) AS team_name, '' AS lead_name
        FROM projects
        WHERE trim(COALESCE(${projectTeamCol}, '')) <> ''
      `);
    }
    return db.prepare(`
      SELECT team_name, MAX(lead_name) AS lead_name
      FROM (
        ${unionParts.join(' UNION ALL ')}
      ) t
      WHERE trim(COALESCE(team_name, '')) <> ''
      GROUP BY team_name
      ORDER BY team_name COLLATE NOCASE
    `).all();
  });

  ipcMain.handle('db:teams:add', async (_e, { name, leadName, actor }) => {
    const baseName = (name || '').trim();
    if (!baseName) return { ok: false, error: 'Team name is required.' };

    const allTeamNames = [
      ...db.prepare("SELECT team_name FROM teams WHERE trim(COALESCE(team_name,'')) <> ''").all().map(r => r.team_name),
      ...readTeamNames('employees', employeeTeamCol),
      ...readTeamNames('projects', projectTeamCol),
    ];
    const existsCi = (teamName) => {
      const n = normalizeTeamName(teamName);
      return allTeamNames.some(t => normalizeTeamName(t) === n);
    };
    let finalName = baseName;
    let idx = 2;
    while (existsCi(finalName)) {
      finalName = `${baseName} (${idx})`;
      idx += 1;
    }

    try {
      db.prepare('INSERT INTO teams(team_name, lead_name) VALUES(?, ?)').run(finalName, (leadName || '').trim());
      appendActivity({
        id: 'N' + Math.random().toString(36).substr(2, 9),
        ts: formatDateTime(new Date()),
        title: `Team added: ${finalName}`,
        message: `Lead: ${(leadName || '').trim() || 'Not set'}.`,
        actor: String(actor || 'system'),
        recipients: [],
        eventType: 'team_add',
      });
      const sync = await syncRowByPk(actor || 'system', 'teams', 'team_name', finalName, 'insert');
      return { ok: true, name: finalName, autoRenamed: finalName !== baseName, sync };
    } catch (e) {
      return { ok: false, error: e?.message || 'Unable to add team.' };
    }
  });

  ipcMain.handle('db:teams:delete', async (_e, { name, actor }) => {
    const teamName = (name || '').trim();
    if (!teamName) return { ok: false, error: 'Team name is required.' };
    const target = normalizeTeamName(teamName);
    const teamRows = db.prepare("SELECT team_name FROM teams WHERE trim(COALESCE(team_name,'')) <> ''").all();
    const empRows = employeeTeamCol
      ? db.prepare(`SELECT ${employeeTeamCol} AS team_name FROM employees WHERE trim(COALESCE(${employeeTeamCol},'')) <> ''`).all()
      : [];
    const projRows = projectTeamCol
      ? db.prepare(`SELECT ${projectTeamCol} AS team_name FROM projects WHERE trim(COALESCE(${projectTeamCol},'')) <> ''`).all()
      : [];

    const teamExact = [...new Set(teamRows.map(r => r.team_name).filter(n => normalizeTeamName(n) === target))];
    const empExact = [...new Set(empRows.map(r => r.team_name).filter(n => normalizeTeamName(n) === target))];
    const projExact = [...new Set(projRows.map(r => r.team_name).filter(n => normalizeTeamName(n) === target))];

    const existsAnywhere = teamExact.length || empExact.length || projExact.length;
    if (!existsAnywhere) return { ok: false, error: 'Team not found.' };

    const affectedEmployees = [];
    const affectedProjects = [];
    if (employeeTeamCol) {
      for (const exact of empExact) {
        affectedEmployees.push(...db.prepare(`SELECT name FROM employees WHERE ${employeeTeamCol}=?`).all(exact).map(r => r.name));
      }
    }
    if (projectTeamCol) {
      for (const exact of projExact) {
        affectedProjects.push(...db.prepare(`SELECT project_id FROM projects WHERE ${projectTeamCol}=?`).all(exact).map(r => r.project_id));
      }
    }

    const tx = db.transaction(() => {
      for (const exact of teamExact) db.prepare('DELETE FROM teams WHERE team_name=?').run(exact);
      if (employeeTeamCol) {
        for (const exact of empExact) db.prepare(`UPDATE employees SET ${employeeTeamCol}='' WHERE ${employeeTeamCol}=?`).run(exact);
      }
      if (projectTeamCol) {
        for (const exact of projExact) db.prepare(`UPDATE projects SET ${projectTeamCol}='' WHERE ${projectTeamCol}=?`).run(exact);
      }
    });
    tx();
    appendActivity({
      id: 'N' + Math.random().toString(36).substr(2, 9),
      ts: formatDateTime(new Date()),
      title: `Team deleted: ${teamName}`,
      message: `Team references were cleared from users/projects.`,
      actor: String(actor || 'system'),
      recipients: [],
      eventType: 'team_delete',
    });
    const mutations = [
      ...teamExact.map(exact => ({ table: 'teams', action: 'delete', pk: 'team_name', pkValue: exact, data: {}, changedAt: new Date().toISOString() })),
      ...[...new Set(affectedEmployees)]
        .map(name => fetchRowByPk('employees', 'name', name))
        .filter(Boolean)
        .map(row => mutationFromRow('employees', 'name', row, 'update')),
      ...[...new Set(affectedProjects)]
        .map(projectId => fetchRowByPk('projects', 'project_id', projectId))
        .filter(Boolean)
        .map(row => mutationFromRow('projects', 'project_id', row, 'update')),
    ];
    const sync = await pushServerMutations(actor || 'system', mutations);
    return { ok: true, deleted: teamExact.length + empExact.length + projExact.length, sync };
  });

  ipcMain.handle('db:tasks:list', (_e, { user, isAdmin }) => {
    const userName = String(user || '').trim();
    if (isAdmin) {
      const role = getUserRoleByName(userName);
      if (role === 'manager') {
        const teamRow = db.prepare(`
          SELECT trim(COALESCE(${employeeTeamCol}, '')) AS team_name
          FROM employees
          WHERE lower(name)=lower(?)
          LIMIT 1
        `).get(userName);
        const userTeam = String(teamRow?.team_name || '').trim();
        return db.prepare(`
          SELECT DISTINCT t.* FROM tasks t
          LEFT JOIN subtasks s ON t.task_id = s.task_id
          LEFT JOIN projects p ON p.project_id = t.project_id
          LEFT JOIN employees assigned_to_emp ON lower(assigned_to_emp.name)=lower(t.assigned_to)
          LEFT JOIN employees assigned_by_emp ON lower(assigned_by_emp.name)=lower(t.assigned_by)
          LEFT JOIN employees sub_assigned_to_emp ON lower(sub_assigned_to_emp.name)=lower(s.assigned_to)
          LEFT JOIN employees sub_assigned_by_emp ON lower(sub_assigned_by_emp.name)=lower(s.assigned_by)
          WHERE (
            lower(trim(COALESCE(t.assigned_to,'')))=lower(trim(?))
            OR lower(trim(COALESCE(t.assigned_by,'')))=lower(trim(?))
            OR lower(trim(COALESCE(s.assigned_to,'')))=lower(trim(?))
            OR lower(trim(COALESCE(s.assigned_by,'')))=lower(trim(?))
            OR (
              trim(?) <> ''
              AND (
                lower(trim(COALESCE(assigned_to_emp.${employeeTeamCol},'')))=lower(trim(?))
                OR lower(trim(COALESCE(assigned_by_emp.${employeeTeamCol},'')))=lower(trim(?))
                OR lower(trim(COALESCE(sub_assigned_to_emp.${employeeTeamCol},'')))=lower(trim(?))
                OR lower(trim(COALESCE(sub_assigned_by_emp.${employeeTeamCol},'')))=lower(trim(?))
                OR instr(',' || lower(replace(COALESCE(p.team_name,''), ', ', ',')) || ',', ',' || lower(trim(?)) || ',') > 0
              )
            )
          )
          ORDER BY t.due_date, t.task_id
        `).all(userName, userName, userName, userName, userTeam, userTeam, userTeam, userTeam, userTeam, userTeam);
      }
      return db.prepare(`
        SELECT * FROM tasks
        WHERE NOT (
          lower(trim(COALESCE(assigned_to,'')))=lower(trim(COALESCE(assigned_by,'')))
          AND lower(trim(COALESCE(assigned_to,'')))<>lower(trim(?))
        )
        ORDER BY due_date, task_id
      `).all(userName);
    }
    return db.prepare(`
      SELECT DISTINCT t.* FROM tasks t
      LEFT JOIN subtasks s ON t.task_id = s.task_id
      WHERE (
        lower(trim(COALESCE(t.assigned_to,'')))=lower(trim(?))
        OR lower(trim(COALESCE(t.assigned_by,'')))=lower(trim(?))
        OR lower(trim(COALESCE(s.assigned_to,'')))=lower(trim(?))
        OR lower(trim(COALESCE(s.assigned_by,'')))=lower(trim(?))
      )
      ORDER BY t.due_date, t.task_id
    `).all(userName, userName, userName, userName);
  });

  ipcMain.handle('db:tasks:create', async (_e, payload) => {
    const actor = String(payload.actor || payload.assignedBy || '').trim();
    if (isSystemAdminUserName(payload.assignedTo) && !isSystemAdminUserName(actor)) {
      return { ok: false, error: 'Only the main Admin user can assign tasks to Admin.' };
    }
    const id = generateTaskId();
    const now = new Date();
    const dateAssigned = formatDateTime(now);
    db.prepare(`
      INSERT INTO tasks (task_id, task_name, description, assigned_to, assigned_by,
        date_assigned, duration_val, duration_unit, due_date, status, remarks,
        input_label, input_type, input_value, validation_rules,
        project_id, pending_target_status, pending_due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, payload.name, payload.description || '', payload.assignedTo,
      payload.assignedBy, dateAssigned, payload.durationVal || '1',
      payload.durationUnit || 'Days', payload.dueDate || '', payload.status || 'Not Started',
      '', payload.inputLabel || '', payload.inputType || '', '', payload.validationRules || '',
      payload.projectId || '', '', ''
    );
    logTaskHistory({
      taskId: id,
      actor: actor || payload.assignedBy || 'system',
      action: 'create',
      summary: `Task created (${payload.name || id}).`,
      details: { after: payload },
    });
    const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    const sync = await pushServerMutations(actor || payload.assignedBy || 'system', [
      mutationFromRow('tasks', 'task_id', row, 'insert'),
    ]);
    return { ok: true, id, sync };
  });

  ipcMain.handle('db:tasks:update', async (_e, { id, ...payload }) => {
    const task = db.prepare('SELECT task_id, task_name, description, assigned_to, assigned_by, project_id, due_date, status, remarks, input_label, input_type, input_value, validation_rules, completed_on, archived_on, pending_target_status, pending_due_date, review_rejected_unseen FROM tasks WHERE task_id=?').get(id);
    if (!task) return { ok: false, error: 'Task not found.' };
    const actor = String(payload.actor || '').trim();
    const isAdminUser = !!payload.isAdminUser;
    const actorRole = getUserRoleByName(actor);
    const actorLower = actor.toLowerCase();
    const isAssigner = actorLower && actorLower === String(task.assigned_by || '').toLowerCase();
    const canConfigureValidation = isAdminUser || isAssigner;
    const nextInputLabel = canConfigureValidation ? String(payload.inputLabel || '') : String(task.input_label || '');
    const nextInputType = canConfigureValidation ? String(payload.inputType || '') : String(task.input_type || '');
    const nextValidationRules = canConfigureValidation ? String(payload.validationRules || '') : String(task.validation_rules || '');
    const validationDefinitionChanged = nextInputType !== String(task.input_type || '')
      || nextInputLabel !== String(task.input_label || '')
      || nextValidationRules !== String(task.validation_rules || '');
    const nextInputValue = validationDefinitionChanged ? '' : String(task.input_value || '');

    const requestedAssignedTo = payload.assignedTo;
    const requestedAssignedBy = payload.assignedBy;
    const assignedToChanged = requestedAssignedTo !== undefined && String(requestedAssignedTo || '') !== String(task.assigned_to || '');
    const assignedByChanged = requestedAssignedBy !== undefined && String(requestedAssignedBy || '') !== String(task.assigned_by || '');
    if (assignedToChanged && isSystemAdminUserName(requestedAssignedTo) && !isSystemAdminUserName(actor)) {
      return { ok: false, error: 'Only the main Admin user can assign tasks to Admin.' };
    }
    if (!isAdminUser && isBaseUserRoleName(actorRole) && !isAssigner && (assignedToChanged || assignedByChanged)) {
      return { ok: false, error: 'Assigned To / Assigned By can only be changed by assignor or admin.' };
    }

    const requestedStatus = String(payload.status || task.status || 'Not Started');
    let finalStatus = requestedStatus;
    const requestedDueDate = payload.dueDate !== undefined ? String(payload.dueDate || '') : String(task.due_date || '');
    const dueDateChanged = requestedDueDate !== String(task.due_date || '');
    const existingDueDateDt = parseDateTime(String(task.due_date || ''));
    const requestedDueDateDt = parseDateTime(requestedDueDate);
    const isPostponedDueDate = dueDateChanged && (
      (existingDueDateDt && requestedDueDateDt)
        ? requestedDueDateDt.getTime() > existingDueDateDt.getTime()
        : true
    );

    const reviewRequiredStatuses = new Set(['Completed', 'On Hold', 'Archived', 'Pending Review']);
    let validationIncomplete = nextInputType.trim() && !nextInputValue.trim();
    let validationPrompt = nextInputType.trim() === 'text' ? 'Enter text' : nextInputType.trim() === 'image' ? 'Attach image' : 'Attach file';
    try {
      const definition = JSON.parse(nextValidationRules);
      if (Array.isArray(definition?.checks) && definition.checks.length) {
        let values = {};
        try { values = JSON.parse(nextInputValue) || {}; } catch {}
        const missingIndex = definition.checks.findIndex(check => !String(values[String(check.id)] || '').trim());
        validationIncomplete = missingIndex >= 0;
        if (missingIndex >= 0) validationPrompt = `Sr. No. ${missingIndex + 1} - ${definition.checks[missingIndex].label || 'Complete validation'}`;
      }
    } catch {}
    if (reviewRequiredStatuses.has(requestedStatus) && validationIncomplete) {
      return { ok: false, error: `Kindly validate: ${validationPrompt}.` };
    }
    const dueDateApprovalRequired = !isAdminUser && isBaseUserRoleName(actorRole) && isPostponedDueDate && !isAssigner;
    if (reviewRequiredStatuses.has(requestedStatus) || dueDateApprovalRequired) {
      const canApprove = isAdminUser || (actor && actor.toLowerCase() === String(task.assigned_by || '').toLowerCase());
      if (!canApprove) {
        finalStatus = 'Pending Review';
      } else {
        if (requestedStatus === 'Pending Review') {
          finalStatus = String(task.pending_target_status || task.status || 'In Progress');
        } else {
          finalStatus = requestedStatus;
        }
      }
    }

    const nowStr = formatDateTime(new Date());
    let completedOn = task.completed_on || null;
    let archivedOn = task.archived_on || null;
    if (finalStatus === 'Completed') {
      completedOn = completedOn || nowStr;
      archivedOn = null;
    } else if (finalStatus === 'Archived') {
      completedOn = completedOn || nowStr;
      archivedOn = nowStr;
    } else {
      completedOn = null;
      archivedOn = null;
    }
    const pendingTargetStatus = finalStatus === 'Pending Review'
      ? (requestedStatus === 'Pending Review' ? (task.pending_target_status || task.status || 'In Progress') : requestedStatus)
      : '';
    const holdDueDateForApproval = finalStatus === 'Pending Review' && dueDateApprovalRequired;
    const pendingDueDate = holdDueDateForApproval ? requestedDueDate : '';
    let resolvedDueDate = requestedDueDate;
    if (holdDueDateForApproval) {
      resolvedDueDate = String(task.due_date || '');
    }
    if (finalStatus !== 'Pending Review' && String(task.pending_due_date || '').trim()) {
      resolvedDueDate = String(task.pending_due_date || resolvedDueDate);
    }

    db.prepare(`
      UPDATE tasks SET task_name=?, description=?, assigned_to=?, assigned_by=?, duration_val=?,
        duration_unit=?, due_date=?, status=?, remarks=?,
        input_label=?, input_type=?, input_value=?, validation_rules=?,
        project_id=?, completed_on=?, archived_on=?, pending_target_status=?, pending_due_date=?, review_rejected_unseen=?
      WHERE task_id=?
    `).run(
      payload.name, payload.description || '', payload.assignedTo, payload.assignedBy || task.assigned_by,
      payload.durationVal || '1', payload.durationUnit || 'Days',
      resolvedDueDate, finalStatus,
      task.remarks || '',
      nextInputLabel,
      nextInputType,
      nextInputValue,
      nextValidationRules,
      payload.projectId || '',
      completedOn, archivedOn, pendingTargetStatus, pendingDueDate,
      finalStatus === 'Pending Review' ? 0 : (task.review_rejected_unseen || 0),
      id
    );
    if (String(finalStatus || '') !== 'Report Issue') {
      db.prepare('DELETE FROM issues WHERE task_id=?').run(id);
    }
    if (String(finalStatus || '') === 'Archived' && String(task.status || '') !== 'Archived') {
      archiveTaskAttachments(db, id, actor || payload.assignedBy || task.assigned_by || 'system');
    }
    logTaskHistory({
      taskId: id,
      actor,
      action: 'update',
      summary: finalStatus === 'Pending Review'
        ? `Update submitted for review (${pendingTargetStatus || 'changes'}).`
        : `Task updated (${finalStatus}).`,
      details: {
        before: task,
        after: {
          task_name: payload.name,
          description: payload.description || '',
          assigned_to: payload.assignedTo,
          assigned_by: payload.assignedBy || task.assigned_by,
          due_date: resolvedDueDate,
          status: finalStatus,
          remarks: task.remarks || '',
          pending_target_status: pendingTargetStatus,
          pending_due_date: pendingDueDate,
        },
      },
    });
    const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    const sync = await pushServerMutations(actor || payload.assignedBy || task.assigned_by || 'system', [
      mutationFromRow('tasks', 'task_id', row, 'update'),
    ]);
    return {
      ok: true,
      sync,
      status: finalStatus,
      dueDate: resolvedDueDate,
      pendingTargetStatus,
      pendingDueDate,
      approvalRequired: (reviewRequiredStatuses.has(requestedStatus) || dueDateApprovalRequired) && finalStatus === 'Pending Review',
      approvers: resolveApproversForTask(task),
    };
  });

  ipcMain.handle('db:tasks:delete', async (_e, { id, actor, fromProjectContext }) => {
    const task = db.prepare('SELECT task_id, task_name, assigned_by, project_id FROM tasks WHERE task_id=?').get(id);
    if (!task) return { ok: false, error: 'Task not found.' };
    const actorRole = getUserRoleByName(actor);
    const assignerRole = getUserRoleByName(task.assigned_by);
    const isPrivileged = actorRole === 'admin' || actorRole === 'manager';
    if (!isPrivileged) return { ok: false, error: 'Only Admin or Manager can delete tasks.' };
    if (String(task.project_id || '').trim() && !fromProjectContext) {
      return { ok: false, error: 'Project tasks can only be deleted from Projects tab.' };
    }
    if (assignerRole === 'admin' && actorRole !== 'admin') {
      return { ok: false, error: 'Tasks assigned by Admin can only be deleted by Admin.' };
    }
    const subtaskIds = db.prepare('SELECT subtask_id FROM subtasks WHERE task_id=?').all(id).map(r => r.subtask_id);
    const taskAttachments = db.prepare('SELECT id, file_path FROM task_attachments WHERE item_id=? AND is_subtask=0').all(id);
    for (const row of taskAttachments) {
      if (row?.file_path) {
        removeStoredAttachmentFile(row.file_path, {
          table: 'task_attachments',
          rowId: row.id,
          scope: 'task_delete',
          deletedBy: String(actor || '').trim() || 'unknown',
          taskId: String(id || ''),
          taskCreatedBy: String(task.assigned_by || ''),
          createdBy: String(task.assigned_by || ''),
          entityType: 'task',
          itemId: String(id || ''),
        });
      }
    }
    for (const subtaskId of subtaskIds) {
      const subtaskAttachments = db.prepare('SELECT id, file_path FROM task_attachments WHERE item_id=? AND is_subtask=1').all(subtaskId);
      for (const row of subtaskAttachments) {
        if (row?.file_path) {
          removeStoredAttachmentFile(row.file_path, {
            table: 'task_attachments',
            rowId: row.id,
            scope: 'task_delete_subtask',
            deletedBy: String(actor || '').trim() || 'unknown',
            taskId: String(id || ''),
            taskCreatedBy: String(task.assigned_by || ''),
            createdBy: String(task.assigned_by || ''),
            entityType: 'subtask',
            itemId: String(subtaskId || ''),
          });
        }
      }
      db.prepare('DELETE FROM task_attachments WHERE item_id=? AND is_subtask=1').run(subtaskId);
    }
    db.prepare('DELETE FROM subtasks WHERE task_id=?').run(id);
    db.prepare('DELETE FROM task_attachments WHERE item_id=? AND is_subtask=0').run(id);
    db.prepare('DELETE FROM task_reminders WHERE item_id=? AND is_subtask=0').run(id);
    db.prepare('DELETE FROM tasks WHERE task_id=?').run(id);
    logTaskHistory({
      taskId: id,
      actor,
      action: 'delete',
      summary: `Task deleted (${task.task_name || id}).`,
      details: { before: task },
    });
    const sync = await pushServerMutations(actor || 'system', [
      { table: 'tasks', action: 'delete', pk: 'task_id', pkValue: id, data: { task_id: id }, changedAt: new Date().toISOString() },
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:tasks:setStatus', async (_e, { id, status, remarks, actor, isAdminUser, reviewRejected }) => {
    const task = db.prepare('SELECT task_id, assigned_to, assigned_by, due_date, status, remarks, input_label, input_type, input_value, validation_rules, completed_on, archived_on, pending_target_status, pending_due_date, review_rejected_unseen FROM tasks WHERE task_id=?').get(id);
    if (!task) return { ok: false, error: 'Task not found.' };
    const requestedStatus = String(status || '').trim() || task.status || 'Not Started';
    let finalStatus = requestedStatus;
    const reviewRequiredStatuses = new Set(['Completed', 'On Hold', 'Archived', 'Pending Review']);
    let validationIncomplete = String(task.input_type || '').trim() && !String(task.input_value || '').trim();
    let validationPrompt = String(task.input_type || '').trim() === 'text'
        ? 'Enter text'
        : String(task.input_type || '').trim() === 'image'
          ? 'Attach image'
          : 'Attach file';
    try {
      const definition = JSON.parse(String(task.validation_rules || ''));
      if (Array.isArray(definition?.checks) && definition.checks.length) {
        let values = {};
        try { values = JSON.parse(String(task.input_value || '')) || {}; } catch {}
        const missingIndex = definition.checks.findIndex(check => !String(values[String(check.id)] || '').trim());
        validationIncomplete = missingIndex >= 0;
        if (missingIndex >= 0) validationPrompt = `Sr. No. ${missingIndex + 1} - ${definition.checks[missingIndex].label || 'Complete validation'}`;
      }
    } catch {}
    if (reviewRequiredStatuses.has(requestedStatus) && validationIncomplete) {
      return { ok: false, error: `Kindly validate: ${validationPrompt}.` };
    }
    if (reviewRequiredStatuses.has(requestedStatus)) {
      const canApprove = !!isAdminUser || (String(actor || '').trim().toLowerCase() === String(task.assigned_by || '').toLowerCase());
      if (!canApprove) finalStatus = 'Pending Review';
      else if (requestedStatus === 'Pending Review') finalStatus = String(task.pending_target_status || task.status || 'In Progress');
      else finalStatus = requestedStatus;
    }
    const nowStr = formatDateTime(new Date());
    let completedOn = task.completed_on || null;
    let archivedOn = task.archived_on || null;
    if (finalStatus === 'Completed') {
      completedOn = completedOn || nowStr;
      archivedOn = null;
    } else if (finalStatus === 'Archived') {
      completedOn = completedOn || nowStr;
      archivedOn = nowStr;
    } else {
      completedOn = null;
      archivedOn = null;
    }
    const pendingTargetStatus = finalStatus === 'Pending Review'
      ? (requestedStatus === 'Pending Review' ? (task.pending_target_status || 'Completed') : requestedStatus)
      : '';
    const canApprovePending = !!isAdminUser || (String(actor || '').trim().toLowerCase() === String(task.assigned_by || '').toLowerCase());
    const applyPendingDueDate = canApprovePending && String(task.status || '') === 'Pending Review' && finalStatus !== 'Pending Review' && String(task.pending_due_date || '').trim();
    const dueDateAfter = applyPendingDueDate ? String(task.pending_due_date || '') : String(task.due_date || '');
    const pendingDueDate = finalStatus === 'Pending Review' ? String(task.pending_due_date || '') : '';
    if (reviewRejected && !isAdminUser) {
      return { ok: false, error: 'Only admin can reject a review.' };
    }
    const isReviewRejection = !!reviewRejected && !!isAdminUser;
    const persistedRemarks = isReviewRejection ? remarks : undefined;
    const rejectedFlag = isReviewRejection ? 1 : (finalStatus === 'Pending Review' ? 0 : (task.review_rejected_unseen || 0));
    let insertedCommentId = null;
    if (persistedRemarks !== undefined) {
      db.prepare('UPDATE tasks SET status=?, remarks=?, due_date=?, completed_on=?, archived_on=?, pending_target_status=?, pending_due_date=?, review_rejected_unseen=? WHERE task_id=?').run(finalStatus, persistedRemarks, dueDateAfter, completedOn, archivedOn, pendingTargetStatus, pendingDueDate, rejectedFlag, id);
      const nextRemarks = String(persistedRemarks || '').trim();
      const prevRemarks = String(task.remarks || '').trim();
      if (nextRemarks && nextRemarks !== prevRemarks) {
        const insertedComment = db.prepare(`
          INSERT INTO task_comments (task_id, author, message, created_on)
          VALUES (?, ?, ?, ?)
        `).run(id, String(actor || 'system'), `Remark: ${nextRemarks}`, formatDateTime(new Date()));
        insertedCommentId = insertedComment.lastInsertRowid;
      }
    } else {
      db.prepare('UPDATE tasks SET status=?, due_date=?, completed_on=?, archived_on=?, pending_target_status=?, pending_due_date=?, review_rejected_unseen=? WHERE task_id=?').run(finalStatus, dueDateAfter, completedOn, archivedOn, pendingTargetStatus, pendingDueDate, rejectedFlag, id);
    }
    if (String(finalStatus || '') !== 'Report Issue') {
      db.prepare('DELETE FROM issues WHERE task_id=?').run(id);
    }
    if (String(finalStatus || '') === 'Archived' && String(task.status || '') !== 'Archived') {
      archiveTaskAttachments(db, id, actor || task.assigned_by || 'system');
    }
    logTaskHistory({
      taskId: id,
      actor,
      action: 'status',
      summary: `Status changed ${task.status} -> ${finalStatus}.`,
      details: {
        before: task,
        after: {
          status: finalStatus,
          remarks: persistedRemarks !== undefined ? persistedRemarks : task.remarks,
          due_date: dueDateAfter,
          pending_target_status: pendingTargetStatus,
          pending_due_date: pendingDueDate,
        },
      },
    });
    const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    const commentRow = insertedCommentId ? fetchRowByPk('task_comments', 'id', insertedCommentId) : null;
    const sync = await pushServerMutations(actor || task.assigned_by || 'system', [
      mutationFromRow('tasks', 'task_id', row, 'update'),
      ...(commentRow ? [mutationFromRow('task_comments', 'id', commentRow, 'insert')] : []),
    ]);
    return {
      ok: true,
      sync,
      status: finalStatus,
      dueDate: dueDateAfter,
      pendingTargetStatus,
      pendingDueDate,
      reviewRejectedUnseen: !!rejectedFlag,
      approvalRequired: reviewRequiredStatuses.has(requestedStatus) && finalStatus === 'Pending Review',
      approvers: resolveApproversForTask(task),
    };
  });

  ipcMain.handle('db:tasks:clearReviewReject', async (_e, { id, actor }) => {
    const task = db.prepare('SELECT task_id, assigned_to FROM tasks WHERE task_id=?').get(id);
    if (!task) return { ok: false, error: 'Task not found.' };
    const canClear = String(actor || '').trim().toLowerCase() === String(task.assigned_to || '').trim().toLowerCase();
    if (!canClear) return { ok: false, error: 'Only assignee can acknowledge this status.' };
    db.prepare('UPDATE tasks SET review_rejected_unseen=0 WHERE task_id=?').run(id);
    const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    const sync = await pushServerMutations(actor || task.assigned_to || 'system', [
      mutationFromRow('tasks', 'task_id', row, 'update'),
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:tasks:validate', async (_e, { id, value, checkId, actor }) => {
    const task = db.prepare('SELECT task_id, assigned_to, assigned_by, input_type, input_value, validation_rules FROM tasks WHERE task_id=?').get(id);
    if (!task) return { ok: false, error: 'Task not found.' };
    const actorName = String(actor || '').trim();
    const canValidate = actorName && [
      task.assigned_to,
      task.assigned_by,
    ].map(name => String(name || '').trim().toLowerCase()).includes(actorName.toLowerCase());
    if (!canValidate && !isPrivilegedRole(actorName)) {
      return { ok: false, error: 'You are not allowed to validate this task.' };
    }
    if (!String(task.input_type || '').trim()) return { ok: false, error: 'Validation is not required for this task.' };
    const nextValue = String(value || '').trim();
    if (!nextValue) return { ok: false, error: 'Validation value is required.' };
    let storedValue = nextValue;
    try {
      const definition = JSON.parse(String(task.validation_rules || ''));
      if (Array.isArray(definition?.checks) && definition.checks.length) {
        let values = {};
        try { values = JSON.parse(String(task.input_value || '')) || {}; } catch {}
        const selectedCheck = definition.checks.find(check => String(check.id) === String(checkId || definition.checks[0]?.id));
        if (!selectedCheck) return { ok: false, error: 'Validation check not found.' };
        values[String(selectedCheck.id)] = nextValue;
        storedValue = JSON.stringify(values);
      }
    } catch {}
    db.prepare('UPDATE tasks SET input_value=? WHERE task_id=?').run(storedValue, id);
    logTaskHistory({
      taskId: id,
      actor: actorName || 'system',
      action: 'validate',
      summary: 'Task validation completed.',
      details: { input_type: task.input_type, input_value: storedValue, check_id: checkId || '' },
    });
    const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    const sync = await pushServerMutations(actorName || 'system', [
      mutationFromRow('tasks', 'task_id', row, 'update'),
    ]);
    return { ok: true, value: storedValue, row, sync };
  });

  ipcMain.handle('db:tasks:restore', async (_e, { id, actor, isAdminUser }) => {
    if (!isAdminUser) return { ok: false, error: 'Only Admin can restore archived tasks.' };
    const task = db.prepare('SELECT task_id, status FROM tasks WHERE task_id=?').get(id);
    if (!task) return { ok: false, error: 'Task not found.' };
    if (String(task.status || '') !== 'Archived') return { ok: false, error: 'Only archived tasks can be restored.' };
    db.prepare(`
      UPDATE tasks
      SET status='In Progress', archived_on=NULL, completed_on=NULL, pending_target_status='', pending_due_date=''
      WHERE task_id=?
    `).run(id);
    logTaskHistory({
      taskId: id,
      actor: String(actor || 'system'),
      action: 'restore',
      summary: 'Task restored from archive.',
      details: { before: task, after: { status: 'In Progress' } },
    });
    const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    const sync = await pushServerMutations(actor || 'system', [
      mutationFromRow('tasks', 'task_id', row, 'update'),
    ]);
    return { ok: true, status: 'In Progress', sync };
  });

  ipcMain.handle('db:tasks:extendNextDay', async (_e, { id, actor, isAdminUser, durationVal, durationUnit, comment }) => {
    const task = db.prepare(`
      SELECT task_id, task_name, assigned_to, assigned_by, status, due_date, duration_val, duration_unit, remarks, pending_target_status
      FROM tasks
      WHERE task_id=?
    `).get(id);
    if (!task) return { ok: false, error: 'Task not found.' };
    const actorName = String(actor || '').trim();
    const actorLower = actorName.toLowerCase();
    const canApprove = !!isAdminUser || (actorLower === String(task.assigned_by || '').trim().toLowerCase());
    const isCustomOverdueExtend = durationVal !== undefined || durationUnit !== undefined || comment !== undefined;
    if (isCustomOverdueExtend) {
      if (!canApprove) return { ok: false, error: 'Only the assignor/admin can extend this task.' };
      const dueDt = parseDateTime(task.due_date);
      if (!dueDt || dueDt.getTime() >= Date.now()) return { ok: false, error: 'Only overdue tasks can be extended.' };
      const nextDurationVal = String(Math.max(1, Number.parseInt(durationVal, 10) || 1));
      const nextDurationUnit = ['Hours', 'Days', 'Weeks'].includes(String(durationUnit || '')) ? String(durationUnit || '') : 'Days';
      const nextDue = dueDateFromDurationValue(nextDurationVal, nextDurationUnit);
      const note = String(comment || '').trim();
      db.prepare(`
        UPDATE tasks
        SET status='In Progress',
            duration_val=?,
            duration_unit=?,
            due_date=?,
            remarks=?,
            archived_on=NULL,
            completed_on=NULL,
            pending_target_status='',
            pending_due_date='',
            review_rejected_unseen=0
        WHERE task_id=?
      `).run(nextDurationVal, nextDurationUnit, nextDue, note || task.remarks || '', id);
      logTaskHistory({
        taskId: id,
        actor: actorName || 'system',
        action: 'extend',
        summary: `Overdue task extended to ${nextDue}.`,
        details: {
          attributedTo: {
            assignor: task.assigned_by || '',
            assignee: task.assigned_to || '',
          },
          comment: note,
          before: {
            status: task.status,
            due_date: task.due_date,
            duration_val: task.duration_val,
            duration_unit: task.duration_unit,
          },
          after: {
            status: 'In Progress',
            due_date: nextDue,
            duration_val: nextDurationVal,
            duration_unit: nextDurationUnit,
          },
        },
      });
      const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
      const sync = await pushServerMutations(actorName || task.assigned_by || 'system', [
        mutationFromRow('tasks', 'task_id', row, 'update'),
      ]);
      return { ok: true, status: 'In Progress', dueDate: nextDue, durationVal: nextDurationVal, durationUnit: nextDurationUnit, remarks: note || task.remarks || '', sync };
    }
    if (!canApprove) return { ok: false, error: 'Only assignor/admin can extend this task.' };
    if (String(task.status || '') !== 'Pending Review' || String(task.pending_target_status || '') !== 'Archived') {
      return { ok: false, error: 'Task is not pending archive approval.' };
    }
    const nextDue = addOneDayToDateString(task.due_date) || formatDateTime(new Date(Date.now() + 86400000));
    db.prepare(`
      UPDATE tasks
      SET status='In Progress',
          due_date=?,
          archived_on=NULL,
          completed_on=NULL,
          pending_target_status='',
          pending_due_date='',
          review_rejected_unseen=0
      WHERE task_id=?
    `).run(nextDue, id);
    db.prepare(`
      INSERT INTO task_comments (task_id, author, message, created_on)
      VALUES (?, ?, ?, ?)
    `).run(id, String(actor || 'system'), `Due date extended to ${nextDue} instead of archive.`, formatDateTime(new Date()));
    logTaskHistory({
      taskId: id,
      actor: String(actor || 'system'),
      action: 'extend',
      summary: 'Daily task extension approved (+1 day).',
      details: {
        before: {
          status: task.status,
          due_date: task.due_date,
          pending_target_status: task.pending_target_status,
        },
        after: {
          status: 'In Progress',
          due_date: nextDue,
          pending_target_status: '',
        },
      },
    });
    const row = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id);
    const sync = await pushServerMutations(actor || task.assigned_by || 'system', [
      mutationFromRow('tasks', 'task_id', row, 'update'),
    ]);
    return { ok: true, status: 'In Progress', dueDate: nextDue, sync };
  });

  ipcMain.handle('db:taskHistory:list', (_e, { taskId, actor }) => {
    if (!isDirectorRole(actor)) return [];
    return db.prepare(`
      SELECT id, task_id, changed_on, changed_by, action, summary, details_json
      FROM task_history
      WHERE task_id=?
      ORDER BY id DESC
    `).all(String(taskId || ''));
  });

  ipcMain.handle('db:taskComments:list', async (_e, { taskId, actor, isAdmin }) => {
    const task = db.prepare('SELECT assigned_to, assigned_by FROM tasks WHERE task_id=?').get(taskId);
    if (!task) return [];
    const actorName = String(actor || '').trim();
    const isParticipant = !!isAdmin || [task.assigned_to, task.assigned_by].map(v => String(v || '').trim().toLowerCase()).includes(actorName.toLowerCase());
    if (!isParticipant) return [];
    const comments = db.prepare(`
      SELECT id, task_id, author, message, created_on
      FROM task_comments
      WHERE task_id=?
      ORDER BY id ASC
    `).all(taskId);
    const attachmentStmt = db.prepare(`
      SELECT id, comment_id, file_name, file_path, added_on
      FROM task_comment_attachments
      WHERE comment_id=?
      ORDER BY id ASC
    `);
    const unreadIds = new Set();
    if (actorName) {
      const unreadRows = db.prepare(`
        SELECT c.id
        FROM task_comments c
        LEFT JOIN task_comment_reads r
          ON r.comment_id=c.id AND lower(r.user_name)=lower(?)
        WHERE c.task_id=? AND lower(COALESCE(c.author,'')) != lower(?) AND r.id IS NULL
      `).all(actorName, taskId, actorName);
      for (const row of unreadRows) unreadIds.add(Number(row.id));
      if (unreadRows.length) {
        const insertRead = db.prepare(`
          INSERT INTO task_comment_reads (comment_id, user_name, read_on)
          VALUES (?, ?, ?)
        `);
      const now = formatDateTime(new Date());
        const readMutations = [];
        for (const row of unreadRows) {
          const inserted = insertRead.run(row.id, actorName, now);
          const readRow = fetchRowByPk('task_comment_reads', 'id', inserted.lastInsertRowid);
          if (readRow) readMutations.push(mutationFromRow('task_comment_reads', 'id', readRow, 'insert'));
        }
        await pushServerMutations(actorName, readMutations);
      }
    }
    const result = [];
    for (const comment of comments) {
      const attachments = await hydrateAttachmentRows('task_comment_attachments', attachmentStmt.all(comment.id), actor, !!isAdmin);
      result.push({ ...comment, isUnread: unreadIds.has(Number(comment.id)), attachments });
    }
    return result;
  });

  ipcMain.handle('db:taskComments:add', async (_e, { taskId, actor, message, filePaths, isAdmin }) => {
    const task = db.prepare('SELECT assigned_to, assigned_by FROM tasks WHERE task_id=?').get(taskId);
    if (!task) return { ok: false, error: 'Task not found.' };
    const actorName = String(actor || '').trim();
    const isParticipant = !!isAdmin || [task.assigned_to, task.assigned_by].map(v => String(v || '').trim().toLowerCase()).includes(actorName.toLowerCase());
    if (!isParticipant) return { ok: false, error: 'Only assignor/assignee can comment.' };
    const now = formatDateTime(new Date());
    const row = db.prepare(`
      INSERT INTO task_comments (task_id, author, message, created_on)
      VALUES (?, ?, ?, ?)
    `).run(taskId, actor || '', message || '', now);
    const commentId = row.lastInsertRowid;
    const insertAttachment = db.prepare(`
      INSERT INTO task_comment_attachments (comment_id, file_name, file_path, added_on)
      VALUES (?, ?, ?, ?)
    `);
    const attachmentIds = [];
    const failed = [];
    for (const fp of (filePaths || [])) {
      try {
        const stored = copyToAttachments(fp, {
          uploadedBy: String(actor || '').trim() || 'unknown',
          taskId: String(taskId || ''),
          taskCreatedBy: String(task.assigned_by || ''),
          entityType: 'task_comment',
          itemId: String(taskId || ''),
          commentId: commentId,
        });
        const inserted = insertAttachment.run(commentId, stored.fileName, stored.filePath, now);
        attachmentIds.push(inserted.lastInsertRowid);
      } catch (error) {
        failed.push({ sourcePath: String(fp || ''), error: String(error?.message || error) });
      }
    }
    if (!String(message || '').trim() && (filePaths || []).length && attachmentIds.length === 0) {
      db.prepare('DELETE FROM task_comments WHERE id=?').run(commentId);
      return { ok: false, error: failed[0]?.error || 'Unable to attach file.' };
    }
    const recipients = [...new Set([task.assigned_to, task.assigned_by].filter(Boolean).map(v => String(v).trim()).filter(v => v.toLowerCase() !== String(actor || '').trim().toLowerCase()))];
    if (recipients.length) {
      appendActivity({
        id: 'N' + Math.random().toString(36).substr(2, 9),
        ts: now,
        title: `New task comment: ${taskId}`,
        message: `${String(actor || 'User')} commented${message ? `: ${String(message).slice(0, 160)}` : ''}`,
        actor: String(actor || 'system'),
        recipients,
        eventType: 'task_comment',
        taskId: String(taskId || ''),
      });
    }
    const commentRow = fetchRowByPk('task_comments', 'id', commentId);
    const mutations = [
      ...(commentRow ? [mutationFromRow('task_comments', 'id', commentRow, 'insert')] : []),
      ...attachmentIds
        .map(id => fetchRowByPk('task_comment_attachments', 'id', id))
        .filter(Boolean)
        .map(row => mutationFromRow('task_comment_attachments', 'id', row, 'insert')),
    ].filter(Boolean);
    const sync = await pushServerMutations(actor || 'system', mutations);
    return { ok: true, id: commentId, failed, sync };
  });

  ipcMain.handle('db:taskComments:delete', async (_e, { commentId, actor, isAdmin }) => {
    const actorName = String(actor || '').trim();
    const id = Number(commentId);
    if (!id) return { ok: false, error: 'Invalid message.' };
    const comment = db.prepare(`
      SELECT c.*, t.assigned_to, t.assigned_by
      FROM task_comments c
      LEFT JOIN tasks t ON t.task_id=c.task_id
      WHERE c.id=?
    `).get(id);
    if (!comment) return { ok: false, error: 'Message not found.' };
    const canDelete = !!isAdmin || String(comment.author || '').trim().toLowerCase() === actorName.toLowerCase();
    if (!canDelete) return { ok: false, error: 'Only the sender or Admin can delete this message.' };
    const attachmentRows = db.prepare('SELECT * FROM task_comment_attachments WHERE comment_id=?').all(id);
    const readRows = db.prepare('SELECT * FROM task_comment_reads WHERE comment_id=?').all(id);
    for (const row of attachmentRows) {
      removeStoredAttachmentFile(row.file_path, {
        table: 'task_comment_attachments',
        rowId: row.id,
        scope: 'task_comment_delete',
        deletedBy: actorName || 'unknown',
        taskId: String(comment.task_id || ''),
        taskCreatedBy: String(comment.assigned_by || ''),
        entityType: 'task_comment',
        itemId: String(comment.task_id || ''),
        commentId: id,
      });
    }
    db.prepare('DELETE FROM task_comment_attachments WHERE comment_id=?').run(id);
    db.prepare('DELETE FROM task_comment_reads WHERE comment_id=?').run(id);
    db.prepare('DELETE FROM task_comments WHERE id=?').run(id);
    const changedAt = new Date().toISOString();
    const sync = await pushServerMutations(actorName || 'system', [
      ...attachmentRows.map(row => ({ table: 'task_comment_attachments', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      ...readRows.map(row => ({ table: 'task_comment_reads', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      { table: 'task_comments', action: 'delete', pk: 'id', pkValue: id, data: {}, changedAt },
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:taskComments:unreadCounts', (_e, { actor, isAdmin }) => {
    const actorName = String(actor || '').trim();
    if (!actorName) return [];
    const rows = db.prepare(`
      SELECT c.task_id, COUNT(*) AS unread_count
      FROM task_comments c
      JOIN tasks t ON t.task_id=c.task_id
      LEFT JOIN task_comment_reads r
        ON r.comment_id=c.id AND lower(r.user_name)=lower(?)
      WHERE lower(COALESCE(c.author,'')) != lower(?)
        AND r.id IS NULL
        AND (
          lower(COALESCE(t.assigned_to,''))=lower(?)
          OR lower(COALESCE(t.assigned_by,''))=lower(?)
          OR ?
        )
      GROUP BY c.task_id
    `).all(actorName, actorName, actorName, actorName, isAdmin ? 1 : 0);
    return rows.map(r => ({ taskId: r.task_id, unreadCount: Number(r.unread_count) || 0 }));
  });

  ipcMain.handle('db:issueComments:list', async (_e, { issueId, actor, isAdmin }) => {
    const issue = db.prepare('SELECT issue_id, reported_by, assigned_to FROM issues WHERE issue_id=?').get(issueId);
    if (!issue) return [];
    const comments = db.prepare(`
      SELECT id, issue_id, author, message, created_on
      FROM issue_comments
      WHERE issue_id=?
      ORDER BY id ASC
    `).all(issueId);
    const attachmentStmt = db.prepare(`
      SELECT id, comment_id, file_name, file_path, added_on
      FROM issue_comment_attachments
      WHERE comment_id=?
      ORDER BY id ASC
    `);
    const result = [];
    for (const comment of comments) {
      const attachments = await hydrateAttachmentRows('issue_comment_attachments', attachmentStmt.all(comment.id), actor, !!isAdmin);
      result.push({ ...comment, attachments });
    }
    return result;
  });

  ipcMain.handle('db:issueComments:add', async (_e, { issueId, actor, message, filePaths, isAdmin }) => {
    const issue = db.prepare('SELECT issue_id, reported_by, assigned_to, task_id FROM issues WHERE issue_id=?').get(issueId);
    if (!issue) return { ok: false, error: 'Issue not found.' };
    if (!String(actor || '').trim()) return { ok: false, error: 'Actor required.' };
    const now = formatDateTime(new Date());
    const row = db.prepare(`
      INSERT INTO issue_comments (issue_id, author, message, created_on)
      VALUES (?, ?, ?, ?)
    `).run(issueId, actor || '', message || '', now);
    const commentId = row.lastInsertRowid;
    const insertAttachment = db.prepare(`
      INSERT INTO issue_comment_attachments (comment_id, file_name, file_path, added_on)
      VALUES (?, ?, ?, ?)
    `);
    const attachmentIds = [];
    const failed = [];
    for (const fp of (filePaths || [])) {
      try {
        const stored = copyToAttachments(fp, {
          uploadedBy: String(actor || '').trim() || 'unknown',
          entityType: 'issue_comment',
          itemId: String(issueId || ''),
          taskId: String(issue.task_id || ''),
          taskCreatedBy: String(issue.reported_by || ''),
          commentId,
        });
        const inserted = insertAttachment.run(commentId, stored.fileName, stored.filePath, now);
        attachmentIds.push(inserted.lastInsertRowid);
      } catch (error) {
        failed.push({ sourcePath: String(fp || ''), error: String(error?.message || error) });
      }
    }
    if (!String(message || '').trim() && (filePaths || []).length && attachmentIds.length === 0) {
      db.prepare('DELETE FROM issue_comments WHERE id=?').run(commentId);
      return { ok: false, error: failed[0]?.error || 'Unable to attach file.' };
    }
    const recipients = [...new Set([issue.reported_by, issue.assigned_to].filter(Boolean).map(v => String(v).trim()).filter(v => v.toLowerCase() !== String(actor || '').trim().toLowerCase()))];
    if (recipients.length) {
      appendActivity({
        id: 'N' + Math.random().toString(36).substr(2, 9),
        ts: now,
        title: `New issue comment: ${issueId}`,
        message: `${String(actor || 'User')} commented${message ? `: ${String(message).slice(0, 160)}` : ''}`,
        actor: String(actor || 'system'),
        recipients,
        eventType: 'issue_comment',
        itemType: 'issue',
        itemId: String(issueId || ''),
        taskId: String(issue.task_id || ''),
      });
    }
    const commentRow = fetchRowByPk('issue_comments', 'id', commentId);
    const mutations = [
      ...(commentRow ? [mutationFromRow('issue_comments', 'id', commentRow, 'insert')] : []),
      ...attachmentIds
        .map(id => fetchRowByPk('issue_comment_attachments', 'id', id))
        .filter(Boolean)
        .map(row => mutationFromRow('issue_comment_attachments', 'id', row, 'insert')),
    ].filter(Boolean);
    const sync = await pushServerMutations(actor || 'system', mutations);
    return { ok: true, id: commentId, failed, sync };
  });

  ipcMain.handle('db:issueComments:delete', async (_e, { commentId, actor, isAdmin }) => {
    const actorName = String(actor || '').trim();
    const id = Number(commentId);
    if (!id) return { ok: false, error: 'Invalid message.' };
    const comment = db.prepare(`
      SELECT c.*, i.reported_by, i.assigned_to, i.task_id
      FROM issue_comments c
      LEFT JOIN issues i ON i.issue_id=c.issue_id
      WHERE c.id=?
    `).get(id);
    if (!comment) return { ok: false, error: 'Message not found.' };
    const canDelete = !!isAdmin || String(comment.author || '').trim().toLowerCase() === actorName.toLowerCase();
    if (!canDelete) return { ok: false, error: 'Only the sender or Admin can delete this message.' };
    const attachmentRows = db.prepare('SELECT * FROM issue_comment_attachments WHERE comment_id=?').all(id);
    for (const row of attachmentRows) {
      removeStoredAttachmentFile(row.file_path, {
        table: 'issue_comment_attachments',
        rowId: row.id,
        scope: 'issue_comment_delete',
        deletedBy: actorName || 'unknown',
        taskId: String(comment.task_id || ''),
        taskCreatedBy: String(comment.reported_by || ''),
        entityType: 'issue_comment',
        itemId: String(comment.issue_id || ''),
        commentId: id,
      });
    }
    db.prepare('DELETE FROM issue_comment_attachments WHERE comment_id=?').run(id);
    db.prepare('DELETE FROM issue_comments WHERE id=?').run(id);
    const changedAt = new Date().toISOString();
    const sync = await pushServerMutations(actorName || 'system', [
      ...attachmentRows.map(row => ({ table: 'issue_comment_attachments', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      { table: 'issue_comments', action: 'delete', pk: 'id', pkValue: id, data: {}, changedAt },
    ]);
    return { ok: true, sync };
  });

  const getSubtaskCommentContext = (subtaskId) => db.prepare(`
    SELECT s.subtask_id, s.task_id, s.assigned_to, s.assigned_by,
           t.assigned_to AS task_assigned_to, t.assigned_by AS task_assigned_by
    FROM subtasks s
    LEFT JOIN tasks t ON t.task_id=s.task_id
    WHERE s.subtask_id=?
  `).get(subtaskId);
  const canUseSubtaskMessages = (context, actor, isAdminFlag = false) => {
    const actorName = String(actor || '').trim().toLowerCase();
    if (!context || !actorName) return !!isAdminFlag;
    return !!isAdminFlag || [
      context.assigned_to,
      context.assigned_by,
      context.task_assigned_to,
      context.task_assigned_by,
    ].map(v => String(v || '').trim().toLowerCase()).includes(actorName);
  };

  ipcMain.handle('db:subtaskComments:list', async (_e, { subtaskId, actor, isAdmin }) => {
    const context = getSubtaskCommentContext(subtaskId);
    if (!canUseSubtaskMessages(context, actor, !!isAdmin)) return [];
    const actorName = String(actor || '').trim();
    const comments = db.prepare(`
      SELECT id, subtask_id, author, message, created_on
      FROM subtask_comments
      WHERE subtask_id=?
      ORDER BY id ASC
    `).all(subtaskId);
    const attachmentStmt = db.prepare(`
      SELECT id, comment_id, file_name, file_path, added_on
      FROM subtask_comment_attachments
      WHERE comment_id=?
      ORDER BY id ASC
    `);
    const unreadIds = new Set();
    if (actorName) {
      const unreadRows = db.prepare(`
        SELECT c.id
        FROM subtask_comments c
        LEFT JOIN subtask_comment_reads r
          ON r.comment_id=c.id AND lower(r.user_name)=lower(?)
        WHERE c.subtask_id=? AND lower(COALESCE(c.author,'')) != lower(?) AND r.id IS NULL
      `).all(actorName, subtaskId, actorName);
      for (const row of unreadRows) unreadIds.add(Number(row.id));
      if (unreadRows.length) {
        const insertRead = db.prepare(`
          INSERT INTO subtask_comment_reads (comment_id, user_name, read_on)
          VALUES (?, ?, ?)
        `);
        const now = formatDateTime(new Date());
        const readMutations = [];
        for (const row of unreadRows) {
          const inserted = insertRead.run(row.id, actorName, now);
          const readRow = fetchRowByPk('subtask_comment_reads', 'id', inserted.lastInsertRowid);
          if (readRow) readMutations.push(mutationFromRow('subtask_comment_reads', 'id', readRow, 'insert'));
        }
        await pushServerMutations(actorName, readMutations);
      }
    }
    const result = [];
    for (const comment of comments) {
      const attachments = await hydrateAttachmentRows('subtask_comment_attachments', attachmentStmt.all(comment.id), actor, !!isAdmin);
      result.push({ ...comment, isUnread: unreadIds.has(Number(comment.id)), attachments });
    }
    return result;
  });

  ipcMain.handle('db:subtaskComments:add', async (_e, { subtaskId, actor, message, filePaths, isAdmin }) => {
    const context = getSubtaskCommentContext(subtaskId);
    if (!context) return { ok: false, error: 'Subtask not found.' };
    if (!canUseSubtaskMessages(context, actor, !!isAdmin)) return { ok: false, error: 'Only subtask/task participants can message.' };
    const now = formatDateTime(new Date());
    const row = db.prepare(`
      INSERT INTO subtask_comments (subtask_id, author, message, created_on)
      VALUES (?, ?, ?, ?)
    `).run(subtaskId, actor || '', message || '', now);
    const commentId = row.lastInsertRowid;
    const insertAttachment = db.prepare(`
      INSERT INTO subtask_comment_attachments (comment_id, file_name, file_path, added_on)
      VALUES (?, ?, ?, ?)
    `);
    const attachmentIds = [];
    const failed = [];
    for (const fp of (filePaths || [])) {
      try {
        const stored = copyToAttachments(fp, {
          uploadedBy: String(actor || '').trim() || 'unknown',
          taskId: String(context.task_id || ''),
          taskCreatedBy: String(context.task_assigned_by || context.assigned_by || ''),
          createdBy: String(context.assigned_by || ''),
          entityType: 'subtask_comment',
          itemId: String(subtaskId || ''),
          commentId,
        });
        const inserted = insertAttachment.run(commentId, stored.fileName, stored.filePath, now);
        attachmentIds.push(inserted.lastInsertRowid);
      } catch (error) {
        failed.push({ sourcePath: String(fp || ''), error: String(error?.message || error) });
      }
    }
    if (!String(message || '').trim() && (filePaths || []).length && attachmentIds.length === 0) {
      db.prepare('DELETE FROM subtask_comments WHERE id=?').run(commentId);
      return { ok: false, error: failed[0]?.error || 'Unable to attach file.' };
    }
    const actorLower = String(actor || '').trim().toLowerCase();
    const recipients = [...new Set([
      context.assigned_to,
      context.assigned_by,
      context.task_assigned_to,
      context.task_assigned_by,
    ].filter(Boolean).map(v => String(v).trim()).filter(v => v.toLowerCase() !== actorLower))];
    if (recipients.length) {
      appendActivity({
        id: 'N' + Math.random().toString(36).substr(2, 9),
        ts: now,
        title: `New subtask message: ${subtaskId}`,
        message: `${String(actor || 'User')} messaged${message ? `: ${String(message).slice(0, 160)}` : ''}`,
        actor: String(actor || 'system'),
        recipients,
        eventType: 'subtask_comment',
        taskId: String(context.task_id || ''),
      });
    }
    const commentRow = fetchRowByPk('subtask_comments', 'id', commentId);
    const mutations = [
      ...(commentRow ? [mutationFromRow('subtask_comments', 'id', commentRow, 'insert')] : []),
      ...attachmentIds
        .map(id => fetchRowByPk('subtask_comment_attachments', 'id', id))
        .filter(Boolean)
        .map(row => mutationFromRow('subtask_comment_attachments', 'id', row, 'insert')),
    ].filter(Boolean);
    const sync = await pushServerMutations(actor || 'system', mutations);
    return { ok: true, id: commentId, failed, sync };
  });

  ipcMain.handle('db:subtaskComments:delete', async (_e, { commentId, actor, isAdmin }) => {
    const actorName = String(actor || '').trim();
    const id = Number(commentId);
    if (!id) return { ok: false, error: 'Invalid message.' };
    const comment = db.prepare(`
      SELECT c.*, s.task_id, s.assigned_by
      FROM subtask_comments c
      LEFT JOIN subtasks s ON s.subtask_id=c.subtask_id
      WHERE c.id=?
    `).get(id);
    if (!comment) return { ok: false, error: 'Message not found.' };
    const canDelete = !!isAdmin || String(comment.author || '').trim().toLowerCase() === actorName.toLowerCase();
    if (!canDelete) return { ok: false, error: 'Only the sender or Admin can delete this message.' };
    const attachmentRows = db.prepare('SELECT * FROM subtask_comment_attachments WHERE comment_id=?').all(id);
    const readRows = db.prepare('SELECT * FROM subtask_comment_reads WHERE comment_id=?').all(id);
    for (const row of attachmentRows) {
      removeStoredAttachmentFile(row.file_path, {
        table: 'subtask_comment_attachments',
        rowId: row.id,
        scope: 'subtask_comment_delete',
        deletedBy: actorName || 'unknown',
        taskId: String(comment.task_id || ''),
        taskCreatedBy: String(comment.assigned_by || ''),
        entityType: 'subtask_comment',
        itemId: String(comment.subtask_id || ''),
        commentId: id,
      });
    }
    db.prepare('DELETE FROM subtask_comment_attachments WHERE comment_id=?').run(id);
    db.prepare('DELETE FROM subtask_comment_reads WHERE comment_id=?').run(id);
    db.prepare('DELETE FROM subtask_comments WHERE id=?').run(id);
    const changedAt = new Date().toISOString();
    const sync = await pushServerMutations(actorName || 'system', [
      ...attachmentRows.map(row => ({ table: 'subtask_comment_attachments', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      ...readRows.map(row => ({ table: 'subtask_comment_reads', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      { table: 'subtask_comments', action: 'delete', pk: 'id', pkValue: id, data: {}, changedAt },
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:subtasks:list', (_e, { taskId }) => {
    return db.prepare('SELECT * FROM subtasks WHERE task_id=? ORDER BY date_assigned').all(taskId);
  });

  ipcMain.handle('db:subtasks:create', async (_e, payload) => {
    const actor = String(payload.actor || payload.assignedBy || '').trim();
    if (isSystemAdminUserName(payload.assignedTo) && !isSystemAdminUserName(actor)) {
      return { ok: false, error: 'Only the main Admin user can assign subtasks to Admin.' };
    }
    const id = 'ST' + Math.random().toString(36).substr(2, 8);
    const dateAssigned = formatDateTime(new Date());
    db.prepare(`
      INSERT INTO subtasks (subtask_id, task_id, subtask_name, status, assigned_to,
        assigned_by, description, date_assigned, duration_val, duration_unit, due_date, remarks,
        input_label, input_type, input_value, validation_rules)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, payload.taskId, payload.name, payload.status || 'Not Started',
      payload.assignedTo, payload.assignedBy, payload.description || '',
      dateAssigned, payload.durationVal || '1', payload.durationUnit || 'Days',
      payload.dueDate || '', payload.remarks || '',
      payload.inputLabel || '', payload.inputType || '', payload.inputValue || '', payload.validationRules || ''
    );
    const sync = await syncRowByPk(actor || payload.assignedBy || 'system', 'subtasks', 'subtask_id', id, 'insert');
    return { ok: true, id, sync };
  });

  ipcMain.handle('db:subtasks:update', async (_e, { id, ...payload }) => {
    const existing = db.prepare('SELECT assigned_to FROM subtasks WHERE subtask_id=?').get(id);
    const actor = String(payload.actor || payload.assignedBy || '').trim();
    const assignedToChanged = payload.assignedTo !== undefined && String(payload.assignedTo || '') !== String(existing?.assigned_to || '');
    if (assignedToChanged && isSystemAdminUserName(payload.assignedTo) && !isSystemAdminUserName(actor)) {
      return { ok: false, error: 'Only the main Admin user can assign subtasks to Admin.' };
    }
    db.prepare(`
      UPDATE subtasks SET subtask_name=?, description=?, assigned_to=?,
        duration_val=?, duration_unit=?, due_date=?, status=?, remarks=?,
        input_label=?, input_type=?, input_value=?, validation_rules=?
      WHERE subtask_id=?
    `).run(
      payload.name, payload.description || '', payload.assignedTo || '',
      payload.durationVal || '1', payload.durationUnit || 'Days',
      payload.dueDate || '', payload.status || 'Not Started',
      payload.remarks || '',
      payload.inputLabel || '', payload.inputType || '', payload.inputValue || '', payload.validationRules || '',
      id
    );
    const sync = await syncRowByPk(actor || 'system', 'subtasks', 'subtask_id', id, 'update');
    return { ok: true, sync };
  });

  ipcMain.handle('db:subtasks:delete', async (_e, { id, actor, isAdmin }) => {
    const subtask = db.prepare(`
      SELECT s.*, t.assigned_by AS task_assigned_by, t.assigned_to AS task_assigned_to
      FROM subtasks s
      LEFT JOIN tasks t ON t.task_id=s.task_id
      WHERE s.subtask_id=?
    `).get(id);
    if (!subtask) return { ok: false, error: 'Subtask not found.' };
    const actorName = String(actor || '').trim();
    const actorLower = actorName.toLowerCase();
    const canApproveDelete = !!isAdmin || [
      subtask.assigned_by,
      subtask.task_assigned_by,
    ].map(v => String(v || '').trim().toLowerCase()).includes(actorLower);
    if (!canApproveDelete) {
      let insertedCommentId = null;
      if (String(subtask.status || '') !== 'Pending Delete') {
        db.prepare('UPDATE subtasks SET status=?, remarks=? WHERE subtask_id=?').run('Pending Delete', `Delete requested by ${actorName || 'User'}`, id);
        const inserted = db.prepare(`
          INSERT INTO subtask_comments (subtask_id, author, message, created_on)
          VALUES (?, ?, ?, ?)
        `).run(id, actorName || 'system', 'Delete requested. Waiting for assignor approval.', formatDateTime(new Date()));
        insertedCommentId = inserted.lastInsertRowid;
      }
      const row = db.prepare('SELECT * FROM subtasks WHERE subtask_id=?').get(id);
      const commentRow = insertedCommentId ? fetchRowByPk('subtask_comments', 'id', insertedCommentId) : null;
      const sync = await pushServerMutations(actorName || 'system', [
        mutationFromRow('subtasks', 'subtask_id', row, 'update'),
        ...(commentRow ? [mutationFromRow('subtask_comments', 'id', commentRow, 'insert')] : []),
      ]);
      return { ok: true, pendingApproval: true, status: 'Pending Delete', row, sync };
    }
    const existing = db.prepare('SELECT id, file_path FROM task_attachments WHERE item_id=? AND is_subtask=1').all(id);
    const reminders = db.prepare('SELECT id FROM task_reminders WHERE item_id=? AND is_subtask=1').all(id);
    const commentRows = db.prepare('SELECT id FROM subtask_comments WHERE subtask_id=?').all(id);
    const commentIds = commentRows.map(r => r.id);
    const commentAttachments = commentIds.length
      ? db.prepare(`SELECT * FROM subtask_comment_attachments WHERE comment_id IN (${commentIds.map(() => '?').join(',')})`).all(...commentIds)
      : [];
    const commentReads = commentIds.length
      ? db.prepare(`SELECT * FROM subtask_comment_reads WHERE comment_id IN (${commentIds.map(() => '?').join(',')})`).all(...commentIds)
      : [];
    const context = resolveAttachmentContext(db, { itemId: id, isSubtask: true });
    for (const row of existing) {
      if (row?.file_path) {
        removeStoredAttachmentFile(row.file_path, {
          table: 'task_attachments',
          rowId: row.id,
          scope: 'subtask_delete',
          deletedBy: String(actor || '').trim() || 'unknown',
          taskId: context.taskId || '',
          taskCreatedBy: context.taskCreatedBy || '',
          createdBy: context.createdBy || '',
          entityType: context.entityType || 'subtask',
          itemId: String(id || ''),
        });
      }
    }
    for (const row of commentAttachments) {
      if (row?.file_path) {
        removeStoredAttachmentFile(row.file_path, {
          table: 'subtask_comment_attachments',
          rowId: row.id,
          scope: 'subtask_delete_comment',
          deletedBy: actorName || 'unknown',
          taskId: context.taskId || '',
          taskCreatedBy: context.taskCreatedBy || '',
          createdBy: context.createdBy || '',
          entityType: 'subtask_comment',
          itemId: String(id || ''),
        });
      }
    }
    db.prepare('DELETE FROM task_attachments WHERE item_id=? AND is_subtask=1').run(id);
    db.prepare('DELETE FROM task_reminders WHERE item_id=? AND is_subtask=1').run(id);
    if (commentIds.length) {
      db.prepare(`DELETE FROM subtask_comment_attachments WHERE comment_id IN (${commentIds.map(() => '?').join(',')})`).run(...commentIds);
      db.prepare(`DELETE FROM subtask_comment_reads WHERE comment_id IN (${commentIds.map(() => '?').join(',')})`).run(...commentIds);
      db.prepare('DELETE FROM subtask_comments WHERE subtask_id=?').run(id);
    }
    db.prepare('DELETE FROM subtasks WHERE subtask_id=?').run(id);
    const changedAt = new Date().toISOString();
    const sync = await pushServerMutations(actorName || 'system', [
      ...existing.map(row => ({ table: 'task_attachments', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      ...reminders.map(row => ({ table: 'task_reminders', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      ...commentAttachments.map(row => ({ table: 'subtask_comment_attachments', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      ...commentReads.map(row => ({ table: 'subtask_comment_reads', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      ...commentRows.map(row => ({ table: 'subtask_comments', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      { table: 'subtasks', action: 'delete', pk: 'subtask_id', pkValue: id, data: {}, changedAt },
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:subtasks:setStatus', async (_e, { id, status, actor }) => {
    db.prepare('UPDATE subtasks SET status=? WHERE subtask_id=?').run(status, id);
    const sync = await syncRowByPk(actor || 'system', 'subtasks', 'subtask_id', id, 'update');
    return { ok: true, sync };
  });

  ipcMain.handle('db:projects:list', (_e, { user, isAdmin }) => {
    if (isAdmin) {
      return db.prepare('SELECT * FROM projects ORDER BY created_on DESC').all();
    }
    const userName = String(user || '').trim();
    if (!userName) return [];
    const teamRow = employeeTeamCol ? db.prepare(`
        SELECT trim(COALESCE(${employeeTeamCol}, '')) AS team_name
        FROM employees
        WHERE lower(name)=lower(?)
        LIMIT 1
      `).get(userName) : null;
    const userTeam = String(teamRow?.team_name || '').trim();
    const relatedProjectIds = new Set(db.prepare(`
      SELECT DISTINCT COALESCE(t.project_id, '') AS project_id
      FROM tasks t
      LEFT JOIN subtasks s ON s.task_id=t.task_id
      WHERE COALESCE(t.project_id,'') <> ''
        AND (
          lower(COALESCE(t.assigned_to,''))=lower(?)
          OR lower(COALESCE(t.assigned_by,''))=lower(?)
          OR lower(COALESCE(s.assigned_to,''))=lower(?)
          OR lower(COALESCE(s.assigned_by,''))=lower(?)
        )
    `).all(userName, userName, userName, userName).map(r => String(r.project_id || '')));
    return db.prepare('SELECT * FROM projects ORDER BY created_on DESC').all().filter((project) => (
      hasMultiValue(project.owner_name, userName) ||
      String(project.created_by || '').trim().toLowerCase() === userName.toLowerCase() ||
      (!!userTeam && hasMultiValue(project.team_name, userTeam)) ||
      relatedProjectIds.has(String(project.project_id || ''))
    ));
  });

  ipcMain.handle('db:projects:create', async (_e, payload) => {
    const actor = String(payload.actor || payload.createdBy || '').trim();
    const name = String(payload.name || '').trim();
    const owner = String(payload.owner || '').trim();
    const team = String(payload.team || '').trim();
    if (!name) {
      return { ok: false, error: 'Project name is required.' };
    }
    if (!owner && !team) {
      return { ok: false, error: 'Select a user or team for this project.' };
    }
    if (hasMultiValue(owner, SYSTEM_ADMIN_NAME) && !isSystemAdminUserName(actor)) {
      return { ok: false, error: 'Only the main Admin user can assign projects to Admin.' };
    }
    const id = 'PRJ' + Math.random().toString(36).substr(2, 4).toUpperCase();
    const now = formatDateTime(new Date());
    db.prepare(`
      INSERT INTO projects (project_id, project_name, description, team_name, owner_name,
        status, priority, start_date, due_date, progress, created_by, created_on, updated_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, payload.description || '', team,
      owner, payload.status || 'Planned', payload.priority || 'Medium',
      payload.start || '', payload.due || '', String(payload.progress || 0),
      payload.createdBy || '', now, now
    );
    const row = db.prepare('SELECT * FROM projects WHERE project_id=?').get(id);
    const sync = await pushServerMutations(actor || 'system', [
      mutationFromRow('projects', 'project_id', row, 'insert'),
    ]);
    return { ok: true, id, sync };
  });

  ipcMain.handle('db:projects:update', async (_e, { id, ...payload }) => {
    const actor = String(payload.actor || payload.createdBy || '').trim();
    const name = String(payload.name || '').trim();
    const owner = String(payload.owner || '').trim();
    const team = String(payload.team || '').trim();
    if (!name) {
      return { ok: false, error: 'Project name is required.' };
    }
    if (!owner && !team) {
      return { ok: false, error: 'Select a user or team for this project.' };
    }
    if (hasMultiValue(owner, SYSTEM_ADMIN_NAME) && !isSystemAdminUserName(actor)) {
      return { ok: false, error: 'Only the main Admin user can assign projects to Admin.' };
    }
    const now = formatDateTime(new Date());
    db.prepare(`
      UPDATE projects SET project_name=?, description=?, team_name=?, owner_name=?,
        status=?, priority=?, start_date=?, due_date=?, progress=?, updated_on=?
      WHERE project_id=?
    `).run(
      name, payload.description || '', team,
      owner, payload.status || 'Planned', payload.priority || 'Medium',
      payload.start || '', payload.due || '', String(payload.progress || 0), now, id
    );
    const row = db.prepare('SELECT * FROM projects WHERE project_id=?').get(id);
    const sync = await pushServerMutations(actor || 'system', [
      mutationFromRow('projects', 'project_id', row, 'update'),
    ]);
    return { ok: true, sync };
  });
  ipcMain.handle('db:projects:delete', async (_e, { id, actor }) => {
    const actorRole = getUserRoleByName(actor);
    if (!isAdminRoleName(actorRole)) {
      return { ok: false, error: 'Only Admin can delete projects.' };
    }
    const project = db.prepare('SELECT project_id, project_name FROM projects WHERE project_id=?').get(id);
    if (!project) return { ok: false, error: 'Project not found.' };
    db.prepare("UPDATE tasks SET project_id='' WHERE project_id=?").run(id);
    db.prepare('DELETE FROM projects WHERE project_id=?').run(id);
    const sync = await pushServerMutations(actor || 'system', [
      { table: 'projects', action: 'delete', pk: 'project_id', pkValue: id, data: { project_id: id }, changedAt: new Date().toISOString() },
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:sops:list', (_e, { user, isAdmin }) => {
    if (isAdmin) {
      return db.prepare('SELECT * FROM sops ORDER BY created_on DESC, sop_id DESC').all();
    }
    return db.prepare('SELECT * FROM sops WHERE lower(assigned_to)=lower(?) ORDER BY created_on DESC, sop_id DESC').all(String(user || ''));
  });

  ipcMain.handle('db:sops:create', (_e, payload) => {
    const sopId = 'SOP' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const now = formatDateTime(new Date());
    db.prepare(`
      INSERT INTO sops (sop_id, sop_task, description, detail_text, attachment_path, assigned_to, assigned_by, created_on, updated_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sopId,
      payload.task || '',
      payload.description || '',
      payload.detail || '',
      payload.attachmentPath || '',
      payload.assignedTo || '',
      payload.assignedBy || '',
      now,
      now
    );
    return { ok: true, id: sopId };
  });

  ipcMain.handle('db:sops:update', (_e, { id, ...payload }) => {
    const now = formatDateTime(new Date());
    db.prepare(`
      UPDATE sops
      SET sop_task=?, description=?, detail_text=?, attachment_path=?, assigned_to=?, updated_on=?
      WHERE sop_id=?
    `).run(
      payload.task || '',
      payload.description || '',
      payload.detail || '',
      payload.attachmentPath || '',
      payload.assignedTo || '',
      now,
      id
    );
    return { ok: true };
  });

  ipcMain.handle('db:sops:delete', (_e, { id }) => {
    db.prepare('DELETE FROM sops WHERE sop_id=?').run(id);
    return { ok: true };
  });

  ipcMain.handle('db:issues:list', () => {
    return db.prepare('SELECT * FROM issues ORDER BY date_reported DESC').all();
  });

  ipcMain.handle('db:issues:create', async (_e, payload) => {
    const actor = String(payload.actor || payload.reportedBy || '').trim();
    if (isSystemAdminUserName(payload.assignedTo) && !isSystemAdminUserName(actor)) {
      return { ok: false, error: 'Only the main Admin user can assign issues to Admin.' };
    }
    const id = 'ISS' + Math.random().toString(36).substr(2, 6);
    const now = formatDateTime(new Date());
    db.prepare(`
      INSERT INTO issues (issue_id, title, description, task_id, reported_by, assigned_to,
        priority, status, date_reported, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, payload.title, payload.description || '', payload.taskId || '',
      payload.reportedBy || '', payload.assignedTo || '', payload.priority || 'Medium',
      payload.status || 'Open', now, payload.remarks || ''
    );
    const creator = String(payload.reportedBy || '').trim() || 'system';
    const seedMessage = `Issue created by ${creator}.`;
    db.prepare(`
      INSERT INTO issue_comments (issue_id, author, message, created_on)
      VALUES (?, ?, ?, ?)
    `).run(id, creator, seedMessage, now);
    const row = db.prepare('SELECT * FROM issues WHERE issue_id=?').get(id);
    const sync = await pushServerMutations(creator, [
      mutationFromRow('issues', 'issue_id', row, 'insert'),
    ]);
    return { ok: true, id, sync };
  });

  ipcMain.handle('db:issues:update', async (_e, { id, ...payload }) => {
    const issue = db.prepare('SELECT issue_id, task_id, status, remarks, title, description, assigned_to, reported_by FROM issues WHERE issue_id=?').get(id);
    if (!issue) return { ok: false, error: 'Issue not found.' };
    const actor = String(payload.actor || '').trim() || 'system';
    if (isSystemAdminUserName(payload.assignedTo) && !isSystemAdminUserName(actor)) {
      return { ok: false, error: 'Only the main Admin user can assign issues to Admin.' };
    }
    const nextStatus = payload.status || 'Open';
    const nextRemarks = payload.remarks || '';
    db.prepare(`
      UPDATE issues SET title=?, description=?, assigned_to=?, priority=?, status=?, remarks=?
      WHERE issue_id=?
    `).run(
      payload.title, payload.description || '', payload.assignedTo || '',
      payload.priority || 'Medium', nextStatus, nextRemarks, id
    );
    const now = formatDateTime(new Date());
    const commentsToAdd = [];
    if (String(issue.status || '') !== String(nextStatus || '')) {
      commentsToAdd.push(`Status changed: ${issue.status || 'Open'} -> ${nextStatus}`);
    }
    const oldRemarks = String(issue.remarks || '').trim();
    const newRemarks = String(nextRemarks || '').trim();
    if (newRemarks && newRemarks !== oldRemarks) {
      commentsToAdd.push(`Remark: ${newRemarks}`);
    }
    if (commentsToAdd.length) {
      const insertComment = db.prepare(`
        INSERT INTO issue_comments (issue_id, author, message, created_on)
        VALUES (?, ?, ?, ?)
      `);
      for (const message of commentsToAdd) insertComment.run(id, actor, message, now);
    }

    let syncedTaskStatus = null;
    const resolvedStates = new Set(['Resolved', 'Closed']);
    if (issue.task_id && resolvedStates.has(String(nextStatus || ''))) {
      const task = db.prepare('SELECT task_id, status, assigned_by FROM tasks WHERE task_id=?').get(issue.task_id);
      if (task && String(task.status || '') === 'Report Issue') {
        db.prepare(`
          UPDATE tasks
          SET status='In Progress', pending_target_status='', pending_due_date='', review_rejected_unseen=0
          WHERE task_id=?
        `).run(task.task_id);
        logTaskHistory({
          taskId: task.task_id,
          actor,
          action: 'status',
          summary: `Linked issue ${id} ${String(nextStatus).toLowerCase()}; task moved to In Progress.`,
          details: {
            before: { status: task.status },
            after: { status: 'In Progress' },
            issueId: id,
            issueStatus: nextStatus,
          },
        });
        db.prepare(`
          INSERT INTO task_comments (task_id, author, message, created_on)
          VALUES (?, ?, ?, ?)
        `).run(task.task_id, actor, `Issue ${id} marked ${nextStatus}. Task moved to In Progress.`, now);
        syncedTaskStatus = { taskId: task.task_id, status: 'In Progress' };
      }
    }

    const mutations = [];
    const issueRow = db.prepare('SELECT * FROM issues WHERE issue_id=?').get(id);
    if (issueRow) mutations.push(mutationFromRow('issues', 'issue_id', issueRow, 'update'));
    if (syncedTaskStatus?.taskId) {
      const taskRow = db.prepare('SELECT * FROM tasks WHERE task_id=?').get(syncedTaskStatus.taskId);
      if (taskRow) mutations.push(mutationFromRow('tasks', 'task_id', taskRow, 'update'));
    }
    const sync = await pushServerMutations(actor, mutations);
    return { ok: true, syncedTaskStatus, sync };
  });
  ipcMain.handle('db:issues:delete', async (_e, { id, actor }) => {
    const issue = db.prepare('SELECT issue_id, title, reported_by FROM issues WHERE issue_id=?').get(id);
    if (!issue) return { ok: false, error: 'Issue not found.' };
    const creator = String(issue.reported_by || '').trim().toLowerCase();
    const byUser = String(actor || '').trim().toLowerCase();
    if (!isAdminRole(actor) && (!creator || creator !== byUser)) {
      return { ok: false, error: 'Only Admin or the issue creator can delete this issue.' };
    }
    const issueAttachmentRows = db.prepare('SELECT id, file_path FROM task_attachments WHERE item_id=? AND is_subtask=0').all(id);
    for (const row of issueAttachmentRows) {
      if (!row?.file_path) continue;
      removeStoredAttachmentFile(row.file_path, {
        table: 'task_attachments',
        rowId: row.id,
        scope: 'issue_delete',
        deletedBy: String(actor || '').trim() || 'unknown',
        entityType: 'issue',
        itemId: String(id || ''),
      });
    }
    db.prepare('DELETE FROM task_attachments WHERE item_id=? AND is_subtask=0').run(id);
    const commentAttachmentRows = db.prepare(`
      SELECT a.id, a.file_path
      FROM issue_comment_attachments a
      JOIN issue_comments c ON c.id=a.comment_id
      WHERE c.issue_id=?
    `).all(id);
    for (const row of commentAttachmentRows) {
      if (!row?.file_path) continue;
      removeStoredAttachmentFile(row.file_path, {
        table: 'issue_comment_attachments',
        rowId: row.id,
        scope: 'issue_delete',
        deletedBy: String(actor || '').trim() || 'unknown',
        entityType: 'issue_comment',
        itemId: String(id || ''),
      });
    }
    db.prepare('DELETE FROM issue_comment_attachments WHERE comment_id IN (SELECT id FROM issue_comments WHERE issue_id=?)').run(id);
    db.prepare('DELETE FROM issue_comments WHERE issue_id=?').run(id);
    db.prepare('DELETE FROM issues WHERE issue_id=?').run(id);
    const sync = await pushServerMutations(actor || 'system', [
      { table: 'issues', action: 'delete', pk: 'issue_id', pkValue: id, data: { issue_id: id }, changedAt: new Date().toISOString() },
    ]);
    return { ok: true, sync };
  });

  const getTodayDateString = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const daysBeforeToday = (logDateStr) => {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const logDate = new Date(`${String(logDateStr || '').trim()}T00:00:00`);
    if (Number.isNaN(logDate.getTime())) return null;
    return Math.round((todayMidnight.getTime() - logDate.getTime()) / 86400000);
  };
  const isWithinDailyUpdateWindow = (logDateStr) => {
    const diff = daysBeforeToday(logDateStr);
    return diff !== null && diff >= 0 && diff <= 2;
  };

  ipcMain.handle('db:dailyUpdates:list', (_e, { actor } = {}) => {
    if (isAdminRole(actor)) {
      return db.prepare('SELECT * FROM daily_updates ORDER BY log_date DESC, employee_name ASC').all();
    }
    const cleanActor = String(actor || '').trim();
    return db.prepare('SELECT * FROM daily_updates WHERE employee_name=? ORDER BY log_date DESC').all(cleanActor);
  });

  ipcMain.handle('db:dailyUpdates:upsert', async (_e, payload = {}) => {
    const actor = String(payload.actor || '').trim();
    if (!actor) return { ok: false, error: 'You must be logged in to submit a daily update.' };
    const logDate = String(payload.logDate || '').trim() || getTodayDateString();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate)) {
      return { ok: false, error: 'Invalid date.' };
    }
    if (!isWithinDailyUpdateWindow(logDate)) {
      return { ok: false, error: 'You can only submit or edit an update for today or the past 2 days.' };
    }
    const workDone = String(payload.workDone || '').trim();
    if (!workDone) {
      return { ok: false, error: 'Please describe the work done before submitting.' };
    }
    const now = formatDateTime(new Date());
    const existing = db.prepare('SELECT * FROM daily_updates WHERE employee_name=? AND log_date=?').get(actor, logDate);
    let id;
    if (existing) {
      id = existing.update_id;
      db.prepare('UPDATE daily_updates SET work_done=?, updated_at=? WHERE update_id=?').run(workDone, now, id);
    } else {
      id = 'DU' + Math.random().toString(36).substr(2, 8);
      db.prepare(`
        INSERT INTO daily_updates (update_id, employee_name, log_date, work_done, submitted_at, updated_at, admin_reply, admin_reply_by, admin_reply_at)
        VALUES (?, ?, ?, ?, ?, ?, '', '', '')
      `).run(id, actor, logDate, workDone, now, now);
    }
    const row = db.prepare('SELECT * FROM daily_updates WHERE update_id=?').get(id);
    const sync = await pushServerMutations(actor, [
      mutationFromRow('daily_updates', 'update_id', row, existing ? 'update' : 'insert'),
    ]);
    return { ok: true, id, sync };
  });

  ipcMain.handle('db:dailyUpdates:reply', async (_e, { id, actor, reply } = {}) => {
    if (!isAdminRole(actor)) {
      return { ok: false, error: 'Only Admins can reply to a daily update.' };
    }
    const existing = db.prepare('SELECT * FROM daily_updates WHERE update_id=?').get(id);
    if (!existing) return { ok: false, error: 'Daily update not found.' };
    const cleanReply = String(reply || '').trim();
    const now = formatDateTime(new Date());
    db.prepare('UPDATE daily_updates SET admin_reply=?, admin_reply_by=?, admin_reply_at=? WHERE update_id=?')
      .run(cleanReply, String(actor || '').trim(), now, id);
    const row = db.prepare('SELECT * FROM daily_updates WHERE update_id=?').get(id);
    const sync = await pushServerMutations(actor || 'system', [
      mutationFromRow('daily_updates', 'update_id', row, 'update'),
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:dailyUpdates:delete', async (_e, { id, actor, isAdmin } = {}) => {
    const cleanId = String(id || '').trim();
    const cleanActor = String(actor || '').trim();
    if (!cleanId) return { ok: false, error: 'Daily update not found.' };
    const existing = db.prepare('SELECT * FROM daily_updates WHERE update_id=?').get(cleanId);
    if (!existing) return { ok: false, error: 'Daily update not found.' };
    const canDelete = !!isAdmin || isAdminRole(cleanActor) || String(existing.employee_name || '').toLowerCase() === cleanActor.toLowerCase();
    if (!canDelete) return { ok: false, error: 'You can only delete your own daily update.' };
    db.prepare('DELETE FROM daily_updates WHERE update_id=?').run(cleanId);
    const sync = await pushServerMutations(cleanActor || 'system', [{
      table: 'daily_updates',
      action: 'delete',
      pk: 'update_id',
      pkValue: cleanId,
      data: { update_id: cleanId },
      changedAt: new Date().toISOString(),
    }]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:recurring:list', () => {
    return db.prepare(`
      SELECT id, task_name, description, assigned_to, assigned_by, frequency, next_run_date,
        duration_val, duration_unit, custom_interval, custom_unit, project_id, reminder_minutes, attachment_paths
      FROM recurring_tasks ORDER BY id DESC
    `).all();
  });

  const normalizeRecurringNextRun = (value) => {
    const parsed = parseDateTime(String(value || ''));
    return parsed ? formatDateTime(parsed) : formatDateTime(new Date());
  };

  const collectRecurringSyncMutations = (templateId, templateAction = 'update') => {
    const mutations = [];
    const templateRow = db.prepare('SELECT * FROM recurring_tasks WHERE id=?').get(templateId);
    if (templateRow) mutations.push(mutationFromRow('recurring_tasks', 'id', templateRow, templateAction));
    const taskRows = db.prepare('SELECT * FROM tasks WHERE template_id=?').all(templateId);
    mutations.push(...taskRows.map(row => mutationFromRow('tasks', 'task_id', row, 'update')));
    const taskIds = taskRows.map(row => row.task_id).filter(Boolean);
    if (taskIds.length) {
      const placeholders = taskIds.map(() => '?').join(',');
      const attachmentRows = db.prepare(`SELECT * FROM task_attachments WHERE item_id IN (${placeholders}) AND is_subtask=0`).all(...taskIds);
      mutations.push(...attachmentRows.map(row => mutationFromRow('task_attachments', 'id', row, 'update')));
    }
    return mutations;
  };

  ipcMain.handle('db:recurring:create', async (_e, payload) => {
    const nextRun = normalizeRecurringNextRun(payload.nextRun);
    const storedAttachmentPaths = persistTemplateAttachmentPaths(payload.attachmentPaths, {
      uploadedBy: String(payload.assignedBy || '').trim() || 'system',
      taskCreatedBy: String(payload.assignedBy || '').trim() || 'system',
      entityType: 'recurring_template',
      itemId: '',
    });
    db.prepare(`
      INSERT INTO recurring_tasks (task_name, description, assigned_to, assigned_by,
        duration_val, duration_unit, frequency, next_run_date,
        custom_interval, custom_unit, project_id, reminder_minutes, attachment_paths)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.taskName, payload.description || '', payload.assignedTo, payload.assignedBy,
      payload.durationVal || '1', payload.durationUnit || 'Days', payload.frequency,
      nextRun, payload.customInterval || '', payload.customUnit || '',
      payload.projectId || '', payload.reminderMinutes || '', JSON.stringify(storedAttachmentPaths)
    );
    const row = db.prepare('SELECT last_insert_rowid() AS id').get();
    processRecurringTasks(db);
    const sync = await pushServerMutations(payload.assignedBy || 'system', collectRecurringSyncMutations(row.id, 'insert'));
    return { ok: true, id: row.id, sync };
  });

  ipcMain.handle('db:recurring:update', async (_e, { id, ...payload }) => {
    const nextRun = normalizeRecurringNextRun(payload.nextRun);
    const prev = db.prepare('SELECT attachment_paths FROM recurring_tasks WHERE id=?').get(id);
    const oldAttachmentPaths = parseAttachmentPaths(prev?.attachment_paths);
    const storedAttachmentPaths = persistTemplateAttachmentPaths(payload.attachmentPaths, {
      uploadedBy: String(payload.assignedBy || '').trim() || 'system',
      taskCreatedBy: String(payload.assignedBy || '').trim() || 'system',
      entityType: 'recurring_template',
      itemId: String(id || ''),
    });
    cleanupTemplateAttachmentFiles(oldAttachmentPaths, storedAttachmentPaths);
    db.prepare(`
      UPDATE recurring_tasks SET task_name=?, description=?, assigned_to=?, assigned_by=?,
        duration_val=?, duration_unit=?, frequency=?, next_run_date=?,
        custom_interval=?, custom_unit=?, project_id=?, reminder_minutes=?, attachment_paths=?
      WHERE id=?
    `).run(
      payload.taskName, payload.description || '', payload.assignedTo, payload.assignedBy,
      payload.durationVal || '1', payload.durationUnit || 'Days', payload.frequency,
      nextRun, payload.customInterval || '', payload.customUnit || '',
      payload.projectId || '', payload.reminderMinutes || '', JSON.stringify(storedAttachmentPaths), id
    );
    processRecurringTasks(db);
    const sync = await pushServerMutations(payload.assignedBy || 'system', collectRecurringSyncMutations(id, 'update'));
    return { ok: true, sync };
  });

  ipcMain.handle('db:recurring:delete', async (_e, { id, isAdminUser, actor }) => {
    if (!isAdminUser) return { ok: false, error: 'Only Admin or Manager can delete recurring templates.' };
    const taskIds = db.prepare('SELECT task_id FROM tasks WHERE template_id=?').all(id);
    for (const row of taskIds) {
      db.prepare('DELETE FROM task_reminders WHERE item_id=? AND is_subtask=0').run(row.task_id);
      const attached = db.prepare('SELECT file_path FROM task_attachments WHERE item_id=? AND is_subtask=0').all(row.task_id);
      db.prepare('DELETE FROM task_attachments WHERE item_id=? AND is_subtask=0').run(row.task_id);
      for (const a of attached) {
        if (a?.file_path) {
          removeStoredAttachmentFile(a.file_path, {
            table: 'task_attachments',
            scope: 'recurring_delete',
            deletedBy: 'system',
            taskId: String(row.task_id || ''),
            entityType: 'task',
            itemId: String(row.task_id || ''),
          });
        }
      }
    }
    const tpl = db.prepare('SELECT attachment_paths FROM recurring_tasks WHERE id=?').get(id);
    cleanupTemplateAttachmentFiles(parseAttachmentPaths(tpl?.attachment_paths));
    db.prepare('DELETE FROM recurring_tasks WHERE id=?').run(id);
    db.prepare('DELETE FROM tasks WHERE template_id=?').run(id);
    const sync = await pushServerMutations(actor || 'system', [
      { table: 'recurring_tasks', action: 'delete', pk: 'id', pkValue: id, data: { id }, changedAt: new Date().toISOString() },
      ...taskIds.map(row => ({ table: 'tasks', action: 'delete', pk: 'task_id', pkValue: row.task_id, data: { task_id: row.task_id }, changedAt: new Date().toISOString() })),
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:recurring:process', () => {
    processRecurringTasks(db);
    return { ok: true };
  });

  ipcMain.handle('db:attachments:list', async (_e, { itemId, isSubtask, actor, isAdmin }) => {
    const canSee = canSeeAttachmentItem(itemId, !!isSubtask, actor, !!isAdmin);
    if (!canSee) return [];
    const rows = db.prepare(`
      SELECT id, item_id, is_subtask, file_name, file_path, added_on, added_by
      FROM task_attachments WHERE item_id=? AND is_subtask=?
      ORDER BY id DESC
    `).all(itemId, isSubtask ? 1 : 0);
    return hydrateAttachmentRows('task_attachments', rows, actor, !!isAdmin);
  });

  ipcMain.handle('db:attachments:add', async (_e, { itemId, isSubtask, filePaths, actor, isAdmin }) => {
    if (!canSeeAttachmentItem(itemId, !!isSubtask, actor, !!isAdmin)) {
      return { ok: false, error: 'You do not have access to add attachments here.' };
    }
    const now = formatDateTime(new Date());
    const stageDir = path.resolve(getClipboardStageDir());
    const context = resolveAttachmentContext(db, { itemId, isSubtask: !!isSubtask });
    const uploadedBy = String(actor || '').trim() || 'unknown';
    const insert = db.prepare(`
      INSERT INTO task_attachments (item_id, is_subtask, file_name, file_path, added_on, added_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const added = [];
    const failed = [];
    const addedIds = [];
    for (const fp of filePaths) {
      try {
        const stored = copyToAttachments(fp, {
          uploadedBy,
          taskId: context.taskId || '',
          taskName: context.taskName || '',
          projectId: context.projectId || '',
          projectName: context.projectName || '',
          taskCreatedBy: context.taskCreatedBy || '',
          createdBy: context.createdBy || '',
          entityType: context.entityType || (isSubtask ? 'subtask' : 'task'),
          itemId: String(itemId || ''),
        });
        const inserted = insert.run(itemId, isSubtask ? 1 : 0, stored.fileName, stored.filePath, now, uploadedBy);
        addedIds.push(inserted.lastInsertRowid);
        added.push({ fileName: stored.fileName, filePath: stored.filePath, addedOn: now });
        try {
          const src = path.resolve(fp);
          if (src.startsWith(stageDir + path.sep) && fs.existsSync(src)) fs.unlinkSync(src);
        } catch {}
      } catch (error) {
        failed.push({ sourcePath: String(fp || ''), error: String(error?.message || error) });
        appendAttachmentAudit({
          action: 'upload',
          status: 'failed',
          sourcePath: String(fp || ''),
          itemId: String(itemId || ''),
          entityType: context.entityType || (isSubtask ? 'subtask' : 'task'),
          uploadedBy,
          taskId: context.taskId || '',
          projectId: context.projectId || '',
          projectName: context.projectName || '',
          error: String(error?.message || error),
        });
      }
    }
    const sync = await pushServerMutations(uploadedBy, addedIds
      .map(id => fetchRowByPk('task_attachments', 'id', id))
      .filter(Boolean)
      .map(row => mutationFromRow('task_attachments', 'id', row, 'insert')));
    return { ok: true, added, failed, sync };
  });

  ipcMain.handle('db:attachments:remove', async (_e, { id, actor }) => {
    const row = db.prepare('SELECT id, item_id, is_subtask, file_path FROM task_attachments WHERE id=?').get(id);
    db.prepare('DELETE FROM task_attachments WHERE id=?').run(id);
    if (row?.file_path) {
      const context = resolveAttachmentContext(db, { itemId: row.item_id, isSubtask: !!row.is_subtask });
      removeStoredAttachmentFile(row.file_path, {
        table: 'task_attachments',
        rowId: id,
        deletedBy: String(actor || '').trim() || 'unknown',
        taskId: context.taskId || '',
        projectId: context.projectId || '',
        projectName: context.projectName || '',
        taskCreatedBy: context.taskCreatedBy || '',
        createdBy: context.createdBy || '',
        entityType: context.entityType || (row.is_subtask ? 'subtask' : 'task'),
        itemId: String(row.item_id || ''),
      });
    }
    const sync = await pushServerMutations(actor || 'system', [
      { table: 'task_attachments', action: 'delete', pk: 'id', pkValue: id, data: {}, changedAt: new Date().toISOString() },
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:attachments:replace', async (_e, { itemId, isSubtask, filePaths, actor }) => {
    const stageDir = path.resolve(getClipboardStageDir());
    const context = resolveAttachmentContext(db, { itemId, isSubtask: !!isSubtask });
    const uploadedBy = String(actor || '').trim() || 'unknown';
    const existing = db.prepare('SELECT id, file_path FROM task_attachments WHERE item_id=? AND is_subtask=?').all(itemId, isSubtask ? 1 : 0);
    db.prepare('DELETE FROM task_attachments WHERE item_id=? AND is_subtask=?').run(itemId, isSubtask ? 1 : 0);
    for (const row of existing) {
      if (row?.file_path) {
        removeStoredAttachmentFile(row.file_path, {
          table: 'task_attachments',
          rowId: row.id,
          scope: 'replace',
          deletedBy: uploadedBy,
          taskId: context.taskId || '',
          projectId: context.projectId || '',
          projectName: context.projectName || '',
          taskCreatedBy: context.taskCreatedBy || '',
          createdBy: context.createdBy || '',
          entityType: context.entityType || (isSubtask ? 'subtask' : 'task'),
          itemId: String(itemId || ''),
        });
      }
    }
    const now = formatDateTime(new Date());
    const insert = db.prepare(`
      INSERT INTO task_attachments (item_id, is_subtask, file_name, file_path, added_on, added_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const addedIds = [];
    for (const fp of filePaths) {
      const stored = copyToAttachments(fp, {
        uploadedBy,
        taskId: context.taskId || '',
        taskCreatedBy: context.taskCreatedBy || '',
        createdBy: context.createdBy || '',
        entityType: context.entityType || (isSubtask ? 'subtask' : 'task'),
        itemId: String(itemId || ''),
      });
      const inserted = insert.run(itemId, isSubtask ? 1 : 0, stored.fileName, stored.filePath, now, uploadedBy);
      addedIds.push(inserted.lastInsertRowid);
      try {
        const src = path.resolve(fp);
        if (src.startsWith(stageDir + path.sep) && fs.existsSync(src)) fs.unlinkSync(src);
      } catch {}
    }
    const changedAt = new Date().toISOString();
    const sync = await pushServerMutations(uploadedBy, [
      ...existing.map(row => ({ table: 'task_attachments', action: 'delete', pk: 'id', pkValue: row.id, data: {}, changedAt })),
      ...addedIds
        .map(id => fetchRowByPk('task_attachments', 'id', id))
        .filter(Boolean)
        .map(row => mutationFromRow('task_attachments', 'id', row, 'insert')),
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:attachments:stageClipboard', (_e, { files }) => {
    const staged = [];
    for (const file of (files || [])) {
      if (!file?.dataBase64) continue;
      try {
        const fp = stageClipboardFile(file);
        staged.push(fp);
      } catch {}
    }
    return { ok: true, filePaths: staged };
  });

  ipcMain.handle('db:attachments:open', async (_e, { table, id, filePath, actor, isAdmin } = {}) => {
    const attachmentTable = String(table || 'task_attachments').trim();
    const attachmentId = String(id || '').trim();
    let target = String(filePath || '').trim();
    try {
      if (target && fs.existsSync(target)) {
        await shell.openPath(target);
        return { ok: true, path: target };
      }
      if (!ATTACHMENT_TABLES.has(attachmentTable) || !attachmentId) {
        return { ok: false, error: 'Invalid attachment.' };
      }
      const row = db.prepare(`SELECT * FROM ${attachmentTable} WHERE id=?`).get(attachmentId);
      if (!row) return { ok: false, error: 'Attachment record not found.' };
      if (!syncConfig?.enabled) return { ok: false, error: 'Attachment is not available locally and sync is not connected.' };
      if (syncConfig.mode === 'drive') {
        target = await downloadDriveAttachmentFile(db, syncConfig.driveScriptUrl, syncConfig.driveToken, syncConfig.cacheDir, attachmentTable, row);
      } else if (syncConfig.mode === 'lan') {
        target = await downloadAttachmentFile(db, syncConfig.serverUrl, syncConfig.token, syncConfig.cacheDir, attachmentTable, row, {
          actor,
          isAdmin: !!isAdmin || isPrivilegedRole(actor),
        });
      } else {
        target = row.file_path || '';
      }
      if (!target || !fs.existsSync(target)) {
        return { ok: false, error: 'Attachment could not be downloaded.' };
      }
      await shell.openPath(target);
      return { ok: true, path: target };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

    const normalizeNotificationEntry = (entry) => ({
    id: String(entry?.id || ''),
    ts: String(entry?.ts || ''),
    title: String(entry?.title || ''),
    message: String(entry?.message || ''),
    actor: String(entry?.actor || ''),
    recipients: uniqueNonEmpty(Array.isArray(entry?.recipients) ? entry.recipients : []),
    eventType: String(entry?.eventType || 'activity'),
    itemType: String(entry?.itemType || ''),
    itemId: String(entry?.itemId || ''),
    projectId: String(entry?.projectId || ''),
    taskId: String(entry?.taskId || ''),
    archived: !!entry?.archived,
    readBy: uniqueNonEmpty(Array.isArray(entry?.readBy) ? entry.readBy : []),
  });
  const markOverflowNotificationsArchived = (entries, limit = 50) => {
    const normalized = (entries || []).map(normalizeNotificationEntry);
    const activeSorted = normalized
      .filter(n => !n.archived)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const keepIds = new Set(activeSorted.slice(0, limit).map(n => n.id));
    return normalized.map((n) => {
      if (n.archived) return n;
      return keepIds.has(n.id) ? n : { ...n, archived: true };
    });
  };

  ipcMain.handle('notifications:add', (_e, payload) => {
    const seededRecipients = Array.isArray(payload.recipients) ? payload.recipients : [];
    const taskRecipients = resolveTaskAudience(payload.taskId);
    const projectRecipients = resolveProjectAudience(payload.projectId);
    const recipients = uniqueNonEmpty([...seededRecipients, ...taskRecipients, ...projectRecipients]);
    const entry = {
      id: payload.id || 'N' + Math.random().toString(36).substr(2, 9),
      ts: payload.ts || formatDateTime(new Date()),
      title: payload.title || '',
      message: payload.message || '',
      actor: payload.actor || '',
      recipients,
      eventType: payload.eventType || 'activity',
      itemType: payload.itemType || '',
      itemId: payload.itemId || '',
      projectId: payload.projectId || '',
      taskId: payload.taskId || '',
      archived: false,
      readBy: [],
    };
    const all = readActivityLog();
    all.push(entry);
    writeActivityLog(markOverflowNotificationsArchived(all, 50));
    return { ok: true, id: entry.id };
  });

  ipcMain.handle('notifications:list', (_e, { user, isAdmin, includeArchived }) => {
    const userName = String(user || '').trim();
    const all = markOverflowNotificationsArchived(readActivityLog(), 50);
    const viewer = isAdmin ? all : all.filter(n => (n.recipients || []).includes(userName));
    const filtered = viewer.filter(n => !!n.archived === !!includeArchived);
    return filtered
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .map(n => ({ ...n, isRead: (n.readBy || []).map(v => String(v).toLowerCase()).includes(userName.toLowerCase()) }));
  });

  ipcMain.handle('notifications:remove', (_e, { id, user, isAdmin }) => {
    const all = readActivityLog();
    const next = all.filter(n => {
      if (n.id !== id) return true;
      if (isAdmin) return false;
      return !((n.recipients || []).includes(user));
    });
    writeActivityLog(next);
    return { ok: true };
  });

  ipcMain.handle('notifications:clear', (_e, { user, isAdmin, includeArchived }) => {
    const userName = String(user || '').trim();
    if (!userName) return { ok: true };
    const all = markOverflowNotificationsArchived(readActivityLog(), 50);
    const next = all.map((n) => {
      const canSee = isAdmin || (n.recipients || []).includes(userName);
      if (!canSee) return n;
      if (!!n.archived !== !!includeArchived) return n;
      const readBy = uniqueNonEmpty([...(n.readBy || []), userName]);
      return { ...n, readBy };
    });
    writeActivityLog(next);
    return { ok: true };
  });

  ipcMain.handle('notifications:markAllRead', (_e, { user, isAdmin, includeArchived }) => {
    const userName = String(user || '').trim();
    if (!userName) return { ok: true };
    const all = markOverflowNotificationsArchived(readActivityLog(), 50);
    const next = all.map((n) => {
      const canSee = isAdmin || (n.recipients || []).includes(userName);
      if (!canSee) return n;
      if (!!n.archived !== !!includeArchived) return n;
      const readBy = uniqueNonEmpty([...(n.readBy || []), userName]);
      return { ...n, readBy };
    });
    writeActivityLog(next);
    return { ok: true };
  });
  ipcMain.handle('db:reminders:set', async (_e, { itemId, isSubtask, dueDate, remindMinutes, actor }) => {
    const existing = db.prepare('SELECT id FROM task_reminders WHERE item_id=? AND is_subtask=?').all(itemId, isSubtask ? 1 : 0);
    db.prepare('DELETE FROM task_reminders WHERE item_id=? AND is_subtask=?').run(itemId, isSubtask ? 1 : 0);
    const minutes = parseInt(remindMinutes) || 0;
    const changedAt = new Date().toISOString();
    if (minutes <= 0) {
      const sync = await pushServerMutations(actor || 'system', existing.map(row => ({
        table: 'task_reminders',
        action: 'delete',
        pk: 'id',
        pkValue: row.id,
        data: {},
        changedAt,
      })));
      return { ok: true, sync };
    }
    const dueDt = parseDateTime(dueDate);
    if (!dueDt) return { ok: false, error: 'Invalid due date' };
    const remindAt = new Date(dueDt.getTime() - minutes * 60000);
    const inserted = db.prepare(`
      INSERT INTO task_reminders (item_id, is_subtask, remind_minutes, due_date, remind_at, created_on)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      itemId, isSubtask ? 1 : 0, String(minutes),
      formatDateTime(dueDt), formatDateTime(remindAt), formatDateTime(new Date())
    );
    const row = fetchRowByPk('task_reminders', 'id', inserted.lastInsertRowid);
    const sync = await pushServerMutations(actor || 'system', [
      ...existing.map(oldRow => ({ table: 'task_reminders', action: 'delete', pk: 'id', pkValue: oldRow.id, data: {}, changedAt })),
      ...(row ? [mutationFromRow('task_reminders', 'id', row, 'insert')] : []),
    ]);
    return { ok: true, sync };
  });

  ipcMain.handle('db:reminders:get', (_e, { itemId, isSubtask }) => {
    const row = db.prepare(`
      SELECT remind_minutes FROM task_reminders
      WHERE item_id=? AND is_subtask=? ORDER BY id DESC LIMIT 1
    `).get(itemId, isSubtask ? 1 : 0);
    return { minutes: row ? parseInt(row.remind_minutes) || 0 : 0 };
  });

  ipcMain.handle('db:reminders:due', (_e, { user, isAdmin }) => {
    const now = new Date();
    const nowStr = formatDateTime(now);
    let taskClause = '';
    let subtaskClause = '';
    const params = [];

    if (!isAdmin && user) {
      taskClause = " AND t.assigned_to=?";
      subtaskClause = " AND s.assigned_to=?";
    }

    const taskRows = db.prepare(`
      SELECT r.id AS reminderId, r.item_id AS itemId, 0 AS isSubtask,
        r.remind_minutes, r.due_date AS dueDate, r.remind_at AS remindAt,
        t.task_name AS itemName, '' AS parentTaskName, t.assigned_to AS assignedTo,
        t.status, COALESCE(t.project_id,'') AS projectId
      FROM task_reminders r
      JOIN tasks t ON t.task_id = r.item_id
      WHERE r.is_subtask=0 AND COALESCE(t.status,'') NOT IN ('Completed','Archived')
      ${taskClause}
    `).all(...(taskClause ? [user] : []));

    const subtaskRows = db.prepare(`
      SELECT r.id AS reminderId, r.item_id AS itemId, 1 AS isSubtask,
        r.remind_minutes, r.due_date AS dueDate, r.remind_at AS remindAt,
        s.subtask_name AS itemName, COALESCE(t.task_name,'') AS parentTaskName,
        s.assigned_to AS assignedTo, s.status,
        COALESCE(t.project_id,'') AS projectId
      FROM task_reminders r
      JOIN subtasks s ON s.subtask_id = r.item_id
      JOIN tasks t ON t.task_id = s.task_id
      WHERE r.is_subtask=1 AND COALESCE(t.status,'') != 'Archived'
        AND COALESCE(s.status,'') != 'Completed'
      ${subtaskClause}
    `).all(...(subtaskClause ? [user] : []));

    const all = [...taskRows, ...subtaskRows].map(r => {
      const remindAtDt = parseDateTime(r.remindAt);
      return {
        ...r,
        isDue: remindAtDt ? remindAtDt <= now : false,
      };
    }).filter(r => r.isDue)
      .sort((a, b) => {
        const aD = parseDateTime(a.remindAt) || new Date(0);
        const bD = parseDateTime(b.remindAt) || new Date(0);
        return aD - bD;
      });
    return all;
  });

  ipcMain.handle('dialog:save-csv', async (_e, csvContent) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Tasks',
      defaultPath: 'tasks-export.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (!result.canceled && result.filePath) {
      const fs = require('fs');
      fs.writeFileSync(result.filePath, csvContent, 'utf-8');
      return { ok: true, path: result.filePath };
    }
    return { ok: false };
  });

  ipcMain.handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
    });
    return result.filePaths || [];
  });

  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : (result.filePaths || [])[0];
  });

  ipcMain.handle('config:db-path:get', () => {
    return getConfiguredDataDir();
  });

  ipcMain.handle('config:db-path:set', (_e, { path: newPath, actor }) => {
    if (!isSuperAdminRole(actor)) return { ok: false, error: 'Only Superadmin can change app settings.' };
    return setConfiguredDataDir(newPath);
  });

  ipcMain.handle('connection:get-mode', () => {
    return getConnectionModeSnapshot();
  });

  ipcMain.handle('connection:set-mode', async (_e, { mode } = {}) => {
    return await setConnectionMode(mode);
  });

  ipcMain.handle('config:app-settings:get', () => {
    const settings = getAppSettingsSnapshot();
    const localOnlyKeys = new Set(['directQueuePollSeconds', 'driveScriptUrl', 'driveToken', 'driveSyncEnabled', 'driveTokenConfigured']);
    try {
      const rows = db.prepare('SELECT key, value FROM app_settings').all();
      for (const row of rows) {
        if (localOnlyKeys.has(row.key)) continue;
        try {
          settings[row.key] = JSON.parse(row.value);
        } catch {
          settings[row.key] = row.value;
        }
      }
    } catch {}
    return settings;
  });

  ipcMain.handle('config:server:discover', async () => {
    const servers = await discoverLanServers();
    return { ok: true, servers };
  });

  ipcMain.handle('config:server:health', async (_e, { serverUrl }) => {
    return checkServerHealth(serverUrl);
  });

  ipcMain.handle('sync:pull', async () => {
    return pullServerSnapshotIfEnabled({ forcePullBeforeQueue: true });
  });

  ipcMain.handle('sync:queue-status', async () => {
    return getCurrentSyncQueueStatus();
  });

  ipcMain.handle('config:app-settings:set', async (_e, data = {}) => {
    try {
      const payload = data || {};
      if (!isSuperAdminRole(payload.actor)) {
        return { ok: false, error: 'Only Superadmin can change app settings.' };
      }
      const saveOnly = !!payload.saveOnly || payload.actionType === 'save';
      const primaryConfigPatch = {};
      const primaryConfigSetErrors = [];
      const setPrimaryConfigValue = (key, value) => {
        primaryConfigPatch[key] = value;
        const storeFile = (() => { try { return configStore?.path || ''; } catch { return ''; } })();
        const beforeStat = storeFile ? statSnapshot(storeFile) : { exists: false };
        try {
          configStore?.set(key, value);
          writeCrashLog('config-store-set-diagnostic-success', null, {
            key,
            storeFile,
            syncPollingActive: !!syncPollingTimer,
            beforeStat,
            afterStat: storeFile ? statSnapshot(storeFile) : { exists: false },
          });
        } catch (error) {
          primaryConfigSetErrors.push(`${key}: ${String(error?.message || error)}`);
          writeCrashLog('primary-config-store-set-failed', error, {
            key,
            storeFile,
            syncPollingActive: !!syncPollingTimer,
            beforeStat,
            afterStat: storeFile ? statSnapshot(storeFile) : { exists: false },
          });
        }
      };
      const previousConfig = syncConfig ? { ...syncConfig } : (saveOnly ? null : loadSyncConfig());
      const previousServerUrl = normalizeServerUrlInput(String(configStore?.get('serverUrl') || process.env.ERP_SERVER_URL || '').trim());
      const previousToken = String(configStore?.get('serverToken') || process.env.ERP_SERVER_TOKEN || '').trim();
      const previousDriveScriptUrl = normalizeDriveScriptUrl(getLocalConfigValue('driveScriptUrl', 'ERP_DRIVE_SCRIPT_URL'));
      const previousDriveToken = getLocalConfigValue('driveToken', 'ERP_DRIVE_TOKEN').trim();
      if (Object.prototype.hasOwnProperty.call(payload, 'autoLaunch')) {
        const autoRes = setAutoLaunch(!!payload.autoLaunch);
        if (!autoRes.ok) return autoRes;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'minimizeToTray')) {
        setPrimaryConfigValue('minimizeToTray', !!payload.minimizeToTray);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'desktopShortcut')) {
        const shortcutRes = setDesktopShortcut(!!payload.desktopShortcut);
        if (!shortcutRes.ok) return shortcutRes;
      }
      const hasServerUrlPatch = Object.prototype.hasOwnProperty.call(payload, 'serverUrl');
      const hasServerTokenPatch = Object.prototype.hasOwnProperty.call(payload, 'serverToken');
      const hasDirectQueuePollPatch = Object.prototype.hasOwnProperty.call(payload, 'directQueuePollSeconds');
      const hasDriveScriptUrlPatch = Object.prototype.hasOwnProperty.call(payload, 'driveScriptUrl');
      const hasDriveTokenPatch = Object.prototype.hasOwnProperty.call(payload, 'driveToken');
      const hasDriveSyncEnabledPatch = Object.prototype.hasOwnProperty.call(payload, 'driveSyncEnabled');
      if (!RUN_AS_REMOTE && (hasDirectQueuePollPatch || hasDriveScriptUrlPatch || hasDriveTokenPatch || hasDriveSyncEnabledPatch)) {
        return { ok: false, error: 'Drive Web Access is available only in the Remote Access app.' };
      }
      const nextServerUrlFromPayload = hasServerUrlPatch ? normalizeServerUrlInput(payload.serverUrl) : previousServerUrl;
      const serverUrlChanged = hasServerUrlPatch && previousServerUrl !== nextServerUrlFromPayload;
      const nextDriveScriptUrlFromPayload = hasDriveScriptUrlPatch ? normalizeDriveScriptUrl(payload.driveScriptUrl) : previousDriveScriptUrl;
      const nextDriveTokenFromPayload = hasDriveTokenPatch ? String(payload.driveToken || '').trim() : previousDriveToken;
      const driveScriptUrlChanged = hasDriveScriptUrlPatch && previousDriveScriptUrl !== nextDriveScriptUrlFromPayload;
      const driveTokenChanged = hasDriveTokenPatch && previousDriveToken !== nextDriveTokenFromPayload;
      if (!saveOnly && (serverUrlChanged || hasServerTokenPatch || driveScriptUrlChanged || driveTokenChanged || hasDirectQueuePollPatch || hasDriveSyncEnabledPatch)) {
        await disconnectSyncConnection(previousConfig, activeLoginUser);
      } else if (saveOnly) {
        stopSyncPolling();
      }
      const configWriteWarnings = [];
      if (hasDirectQueuePollPatch) {
        const seconds = String(Math.max(1, Number.parseInt(payload.directQueuePollSeconds, 10) || 10));
        setPrimaryConfigValue('directQueuePollSeconds', seconds);
      }
      if (hasDriveScriptUrlPatch) {
        setPrimaryConfigValue('driveScriptUrl', nextDriveScriptUrlFromPayload);
        if (nextDriveScriptUrlFromPayload && !hasDriveSyncEnabledPatch && !payload.saveOnly) {
          setPrimaryConfigValue('driveSyncEnabled', true);
        }
        if (nextDriveScriptUrlFromPayload) {
          setPrimaryConfigValue('serverUrl', '');
          setPrimaryConfigValue('serverToken', '');
        }
      }
      if (hasDriveTokenPatch) {
        setPrimaryConfigValue('driveToken', nextDriveTokenFromPayload);
      }
      if (hasDriveSyncEnabledPatch) {
        setPrimaryConfigValue('driveSyncEnabled', !!payload.driveSyncEnabled);
      }
      if (hasServerUrlPatch) {
        setPrimaryConfigValue('serverUrl', nextServerUrlFromPayload);
        if (nextServerUrlFromPayload) {
          setPrimaryConfigValue('driveScriptUrl', '');
          setPrimaryConfigValue('driveSyncEnabled', false);
        }
        if (serverUrlChanged && !hasServerTokenPatch) {
          setPrimaryConfigValue('serverToken', '');
        }
      }
      if (hasServerTokenPatch) {
        setPrimaryConfigValue('serverToken', String(payload.serverToken || '').trim());
      }
      const primaryConfigWrite = await injectPrimaryConfigJson(primaryConfigPatch);
      if (!primaryConfigWrite.ok) {
        const fileName = primaryConfigWrite.path ? path.basename(primaryConfigWrite.path) : 'app config JSON';
        const setErrorDetail = primaryConfigSetErrors.length ? ` Store error: ${primaryConfigSetErrors.join('; ')}` : '';
        // Non-fatal, same reasoning as the Drive/LAN write warnings above:
        // setPrimaryConfigValue() already updated configStore and the
        // in-memory override, so this process's behavior for the rest of
        // its lifetime is correct regardless of whether this specific
        // restart is actually at risk here.
        configWriteWarnings.push(`${fileName} may not persist after restart: ${primaryConfigWrite.error || 'Unknown error'}.${setErrorDetail}`);
      }
      if (!saveOnly && (hasServerUrlPatch || hasServerTokenPatch || hasDirectQueuePollPatch || hasDriveScriptUrlPatch || hasDriveTokenPatch || hasDriveSyncEnabledPatch)) loadSyncConfig();
      if (Object.prototype.hasOwnProperty.call(payload, 'taskIdPrefix')) {
        const prefix = String(payload.taskIdPrefix || '').trim().replace(/\s+/g, '').slice(0, 24);
        db.prepare(`
          INSERT INTO app_settings(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).run('taskIdPrefix', JSON.stringify(prefix));
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'taskIdNextNumber')) {
        const rawNextNumber = String(payload.taskIdNextNumber || '').trim();
        const nextNumber = rawNextNumber ? String(Math.max(1, Number.parseInt(rawNextNumber, 10) || 1)) : '';
        db.prepare(`
          INSERT INTO app_settings(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).run('taskIdNextNumber', JSON.stringify(nextNumber));
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'tableColumnWidths')) {
        const widths = payload.tableColumnWidths && typeof payload.tableColumnWidths === 'object' ? payload.tableColumnWidths : {};
        db.prepare(`
          INSERT INTO app_settings(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).run('tableColumnWidths', JSON.stringify(widths));
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'tableRowHeights')) {
        const heights = payload.tableRowHeights && typeof payload.tableRowHeights === 'object' ? payload.tableRowHeights : {};
        db.prepare(`
          INSERT INTO app_settings(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).run('tableRowHeights', JSON.stringify(heights));
      }
      const nextServerUrl = normalizeServerUrlInput(String(configStore?.get('serverUrl') || process.env.ERP_SERVER_URL || '').trim());
      const nextToken = String(configStore?.get('serverToken') || process.env.ERP_SERVER_TOKEN || '').trim();
      const nextDriveScriptUrl = normalizeDriveScriptUrl(getLocalConfigValue('driveScriptUrl', 'ERP_DRIVE_SCRIPT_URL'));
      const nextDriveToken = getLocalConfigValue('driveToken', 'ERP_DRIVE_TOKEN').trim();
      const serverConnectionChanged = previousServerUrl !== nextServerUrl || previousToken !== nextToken || previousDriveScriptUrl !== nextDriveScriptUrl || previousDriveToken !== nextDriveToken;
      const explicitServerAction = hasServerUrlPatch || hasServerTokenPatch || hasDirectQueuePollPatch || hasDriveScriptUrlPatch || hasDriveTokenPatch || hasDriveSyncEnabledPatch;
      let initialPull = { ok: true, skipped: true };
      let serverHealth = null;
      if (!saveOnly && explicitServerAction) {
        loadSyncConfig();
      }
      if (!saveOnly && (serverConnectionChanged || explicitServerAction)) {
        serverHealth = nextDriveScriptUrl ? await checkDriveHealth(nextDriveScriptUrl, nextDriveToken) : (nextServerUrl ? await checkServerHealth(nextServerUrl) : null);
        initialPull = serverHealth?.ok === false ? { ok: false, error: serverHealth.error || 'Connection not available.' } : await pullServerSnapshotIfEnabled({ forcePullBeforeQueue: true });
        if (syncConfig?.enabled && serverHealth?.ok !== false && initialPull?.ok) {
          startSyncPollingIfEnabled();
        } else {
          stopSyncPolling();
        }
      } else if (saveOnly) {
        stopSyncPolling();
      }
      const settings = getAppSettingsSnapshot();
      const connection = getServerConnectionSnapshot(initialPull, serverHealth);
      const warning = configWriteWarnings.length ? configWriteWarnings.join(' ') : undefined;
      if (saveOnly) {
        return { ok: true, settings, sync: { ok: true, skipped: true }, initialPull, connection, warning };
      }
      const persistedKeys = ['autoLaunch', 'desktopShortcut', 'minimizeToTray', 'serverUrl', 'taskIdPrefix', 'taskIdNextNumber', 'tableColumnWidths', 'tableRowHeights'];
      const upsert = db.prepare(`
        INSERT INTO app_settings(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `);
      for (const key of persistedKeys) {
        if (Object.prototype.hasOwnProperty.call(settings, key)) {
          upsert.run(key, JSON.stringify(settings[key]));
        }
      }
      const sync = await pushServerMutations('settings', persistedKeys
        .map(key => fetchRowByPk('app_settings', 'key', key))
        .filter(Boolean)
        .map(row => mutationFromRow('app_settings', 'key', row, 'update')));
      return { ok: true, settings, sync, initialPull, connection, warning };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('shell:open-path', (_e, filePath) => {
    const target = String(filePath || '').trim();
    if (!target) return { ok: false, error: 'Invalid path' };
    if (!fs.existsSync(target)) {
      appendAttachmentAudit({ action: 'open_missing', filePath: target });
      dialog.showErrorBox('Attachment Error', 'Error! File not found.');
      return { ok: false, error: 'Error! File not found.' };
    }
    shell.openPath(target);
    return { ok: true };
  });
}

function formatDateTime(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yy} ${hh}:${mi}`;
}

function parseDateTime(value) {
  if (!value) return null;
  const fmts = [
    { regex: /^(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/, hasTm: true },
    { regex: /^(\d{2})-(\d{2})-(\d{2})$/, hasTm: false },
  ];
  for (const { regex, hasTm } of fmts) {
    const m = value.match(regex);
    if (m) {
      const d = new Date(2000 + parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]),
        hasTm ? parseInt(m[4]) : 9, hasTm ? parseInt(m[5]) : 0);
      return d;
    }
  }
  return null;
}

function advanceRecurringDate(baseDate, frequency, customInterval, customUnit) {
  if (!baseDate) return null;
  const d = new Date(baseDate);
  const interval = Math.max(1, parseInt(customInterval) || 1);
  switch (frequency) {
    case 'Daily': d.setDate(d.getDate() + 1); break;
    case 'Weekly': d.setDate(d.getDate() + 7); break;
    case 'Monthly': d.setMonth(d.getMonth() + 1); break;
    case 'Annually': d.setFullYear(d.getFullYear() + 1); break;
    case 'Custom':
      if (customUnit === 'Weeks') d.setDate(d.getDate() + interval * 7);
      else if (customUnit === 'Months') d.setMonth(d.getMonth() + interval);
      else d.setDate(d.getDate() + interval);
      break;
    default: d.setDate(d.getDate() + 1);
  }
  return d;
}

function addOneDayToDateString(value) {
  const dt = parseDateTime(String(value || ''));
  if (!dt) return '';
  dt.setDate(dt.getDate() + 1);
  return formatDateTime(dt);
}

function dueDateFromDurationValue(durationVal, durationUnit) {
  const amount = Math.max(1, Number.parseInt(durationVal, 10) || 1);
  let deltaMs = amount * 86400000;
  if (String(durationUnit || '') === 'Hours') deltaMs = amount * 3600000;
  else if (String(durationUnit || '') === 'Weeks') deltaMs = amount * 7 * 86400000;
  return formatDateTime(new Date(Date.now() + deltaMs));
}

function processRecurringTasks(db) {
  const templates = db.prepare(`
    SELECT id, task_name, description, assigned_to, assigned_by,
      duration_val, duration_unit, frequency, next_run_date,
      custom_interval, custom_unit, project_id, reminder_minutes, attachment_paths
    FROM recurring_tasks
  `).all();
  const insertAttachment = db.prepare(`
    INSERT INTO task_attachments (item_id, is_subtask, file_name, file_path, added_on, added_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  // Archive old completed tasks
  const completedTasks = db.prepare("SELECT task_id, due_date FROM tasks WHERE status='Completed'").all();
  for (const row of completedTasks) {
    const dueDt = parseDateTime(row.due_date);
    if (dueDt && dueDt < thirtyDaysAgo) {
      db.prepare("UPDATE tasks SET status='Archived', archived_on=COALESCE(NULLIF(archived_on,''), ?) WHERE task_id=?").run(formatDateTime(now), row.task_id);
      archiveTaskAttachments(db, row.task_id, 'system');
    }
  }

  for (const t of templates) {
    let nextRun = parseDateTime(t.next_run_date);
    let hasTime = (t.next_run_date || '').includes(' ');
    if (!nextRun) {
      nextRun = new Date();
      hasTime = true;
      db.prepare('UPDATE recurring_tasks SET next_run_date=? WHERE id=?').run(formatDateTime(nextRun), t.id);
    }

    const durationValue = parseInt(t.duration_val) || 0;
    let deltaMs;
    if (t.duration_unit === 'Hours') deltaMs = durationValue * 3600000;
    else if (t.duration_unit === 'Weeks') deltaMs = durationValue * 7 * 86400000;
    else deltaMs = durationValue * 86400000;

    const dueDateStr = formatDateTime(nextRun);
    const exists = db.prepare(
      'SELECT COUNT(*) AS cnt FROM tasks WHERE template_id=? AND due_date=?'
    ).get(t.id, dueDateStr).cnt > 0;

    const startAtMs = nextRun.getTime() - deltaMs;
    const shouldGenerate = now.getTime() >= startAtMs && !exists;

    if (shouldGenerate) {
      if (t.frequency === 'Daily') {
        const openRows = db.prepare(`
          SELECT task_id, due_date
          FROM tasks
          WHERE template_id=?
            AND COALESCE(status,'') NOT IN ('Completed', 'Archived', 'Pending Review')
        `).all(t.id);
        const setPending = db.prepare(`
          UPDATE tasks
          SET status='Pending Review',
              pending_target_status='Archived',
              pending_due_date=?,
              archived_on=NULL,
              review_rejected_unseen=0
          WHERE task_id=?
        `);
        const addComment = db.prepare(`
          INSERT INTO task_comments (task_id, author, message, created_on)
          VALUES (?, ?, ?, ?)
        `);
        const addHistory = db.prepare(`
          INSERT INTO task_history (task_id, changed_on, changed_by, action, summary, details_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const row of openRows) {
          const suggestedNextDue = addOneDayToDateString(row.due_date) || formatDateTime(new Date(now.getTime() + 86400000));
          setPending.run(suggestedNextDue, row.task_id);
          const nowStr = formatDateTime(now);
          addComment.run(
            row.task_id,
            'system',
            `Daily rollover requested archive approval. Suggested extension due date: ${suggestedNextDue}.`,
            nowStr
          );
          addHistory.run(
            row.task_id,
            nowStr,
            'system',
            'status',
            'Daily rollover submitted for archive approval.',
            JSON.stringify({
              before: { status: 'In Progress', due_date: row.due_date || '' },
              after: {
                status: 'Pending Review',
                pending_target_status: 'Archived',
                pending_due_date: suggestedNextDue,
              },
            })
          );
        }
      } else {
        const oldRows = db.prepare(
          "SELECT task_id, remarks FROM tasks WHERE template_id=? AND status != 'Completed'"
        ).all(t.id);
        for (const old of oldRows) {
          const remarks = old.remarks || '';
          if (!remarks.includes('Overdue')) {
            db.prepare('UPDATE tasks SET remarks=? WHERE task_id=?').run(`${remarks} [Overdue]`.trim(), old.task_id);
          }
        }
      }

      const taskId = 'T' + Math.random().toString(36).substr(2, 6).toUpperCase();
      db.prepare(`
        INSERT INTO tasks (task_id, task_name, description, assigned_to, assigned_by,
          date_assigned, duration_val, duration_unit, due_date, status, remarks, template_id, project_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId, t.task_name, t.description, t.assigned_to, t.assigned_by,
        formatDateTime(now), t.duration_val, t.duration_unit, dueDateStr,
        'Not Started', '', t.id, (t.project_id || '').trim()
      );
      const templateAttachmentPaths = parseAttachmentPaths(t.attachment_paths);
      for (const sourcePath of templateAttachmentPaths) {
        try {
          if (!sourcePath || !fs.existsSync(sourcePath)) continue;
          const stored = copyToAttachments(sourcePath, {
            uploadedBy: 'system',
            taskId: String(taskId || ''),
            taskCreatedBy: String(t.assigned_by || ''),
            createdBy: String(t.assigned_by || ''),
            entityType: 'task',
            itemId: String(taskId || ''),
            sourceTemplateId: String(t.id || ''),
          });
          insertAttachment.run(taskId, 0, stored.fileName, stored.filePath, formatDateTime(new Date()), 'system');
        } catch {}
      }
    }

    if (shouldGenerate || exists) {
      const newDate = advanceRecurringDate(nextRun, t.frequency, t.custom_interval, t.custom_unit);
      if (newDate) {
        const fmtStr = hasTime ? formatDateTime(newDate) : formatDateTime(newDate).split(' ')[0];
        db.prepare('UPDATE recurring_tasks SET next_run_date=? WHERE id=?').run(fmtStr, t.id);
      }
    }
  }
}

app.whenReady().then(async () => {
  launchedAt = Date.now();
  launchedAtLogin = detectLaunchedAtLogin();
  if (RUN_AS_SERVER) {
    configStore?.set('dbBaseDir', resolveServerDbBaseDir());
  }
  if (getBooleanSetting('autoLaunch', false)) {
    setAutoLaunch(true);
  }
  if (configStore && configStore.get('minimizeToTray') === undefined) {
    configStore.set('minimizeToTray', true);
  }

  if (RUN_AS_SERVER) {
    try {
      const setupOk = await runFirstTimeSetup();
      if (!setupOk) {
        app.quit();
        return;
      }
      if (!process.env.ERP_SERVER_DB_DIR) {
        process.env.ERP_SERVER_DB_DIR = getDbBaseDir();
      }
      managedServer = require('./server');
      registerServerIpcHandlers();
      createTray();
      createServerManagerWindow();
      const status = await managedServer.startServer();
      if (status?.error) {
        writeCrashLog('server-start-returned-error', null, status);
      }
    } catch (error) {
      const logPath = writeCrashLog('server-startup-error', error);
      dialog.showErrorBox(
        'Server Startup Error',
        `Task Manager Server could not start.\n\n${error?.message || error}\n\nCrash log:\n${logPath || getCrashLogDir()}`
      );
      app.quit();
    }
    return;
  }
  try {
    const setupOk = await runFirstTimeSetup();
    if (!setupOk) {
      app.quit();
      return;
    }
    await promptForLanServerConnectionForVersion();
    loadSyncConfig();
    ensureAttachmentStorageReady();
    ensureDatabaseAutoRestore();
    initDatabase(getRuntimeDbBaseDir());
    await pullServerSnapshotIfEnabled();
    snapshotDatabaseBackup();
    seedAttachmentBackupsFromDb(getDatabase());
    clearRemoteAttachmentPathsForClient(getDatabase());
    verifyAttachmentIntegrity(getDatabase());
    processRecurringTasks(getDatabase());
    buildMenu();
    registerIpcHandlers();
    createTray();
    createWindow();
    startSyncPollingIfEnabled();
  } catch (error) {
    writeCrashLog('startup-error', error);
    dialog.showErrorBox("Startup Error", "An error occurred during startup:\n\n" + error.message);
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Check for due reminders every 60 seconds and notify
  setInterval(() => {
    if (!mainWindow) return;
    const db = getDatabase();
    if (!db) return;
    try {
      const now = new Date();
      const rows = db.prepare(`
        SELECT r.item_id, r.remind_at, t.task_name, t.assigned_to
        FROM task_reminders r
        JOIN tasks t ON t.task_id = r.item_id
        WHERE r.is_subtask=0 AND COALESCE(t.status,'') NOT IN ('Completed','Archived')
      `).all();
      for (const r of rows) {
        const remindAt = parseDateTime(r.remind_at);
        if (remindAt && remindAt <= now && remindAt > new Date(now.getTime() - 120000)) {
          const { Notification } = require('electron');
          if (Notification.isSupported()) {
            new Notification({
              title: 'Task Reminder',
              body: `"${r.task_name}" assigned to ${r.assigned_to} is due soon!`,
            }).show();
          }
        }
      }
    } catch (e) { /* ignore */ }
  }, 60000);
}).catch((error) => {
  writeCrashLog('startup-promise-error', error);
  dialog.showErrorBox("Startup Promise Error", error.message || String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (isQuitting || !tray)) {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (activeLoginUser) {
    releaseServerLoginSession(activeLoginUser).catch(() => {});
  }
  if (managedServer) {
    managedServer.stopServer().catch(() => {});
  }
  if (RUN_AS_SERVER) {
    const db = getDatabase();
    if (db) db.close();
    return;
  }
  snapshotDatabaseBackup();
  const db = getDatabase();
  if (db) db.close();
});
