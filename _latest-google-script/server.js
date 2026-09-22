const http = require('http');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const Database = require('better-sqlite3');
const { initDatabase, getDatabase, ensureSystemAdmin, SYSTEM_ADMIN_NAME } = require('./database');
const { appsScriptGet, appsScriptPost, normalizeDriveScriptUrl, readFileBase64 } = require('./drive-web-sync');

function getCrashLogDir() {
  const exeDir = process.versions?.electron ? path.dirname(process.execPath) : process.cwd();
  return path.join(exeDir, 'crash-logs');
}

function writeCrashLog(reason, error, detail = {}) {
  try {
    const dir = getCrashLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `crash-${stamp}.log`);
    fs.writeFileSync(file, [
      `Reason: ${reason}`,
      `Time: ${new Date().toISOString()}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Node: ${process.version}`,
      `Command: ${process.argv.join(' ')}`,
      `Detail: ${JSON.stringify(detail || {}, null, 2)}`,
      '',
      error?.stack || error?.message || String(error || ''),
      '',
    ].join('\n'), 'utf8');
    return file;
  } catch {
    return '';
  }
}

process.on('uncaughtException', (error) => {
  writeCrashLog('server-uncaughtException', error);
});

process.on('unhandledRejection', (error) => {
  writeCrashLog('server-unhandledRejection', error);
});

const BASE_PORT = Number(process.env.ERP_SERVER_PORT || 3587);
const HOST = process.env.ERP_SERVER_HOST || '0.0.0.0';
const DB_DIR = process.env.ERP_SERVER_DB_DIR || path.join(process.cwd(), 'server-data');
const TOKEN_FILE = path.join(DB_DIR, 'server-token.txt');
const DIRECT_ACCESS_TOKEN_FILE = path.join(DB_DIR, 'direct-access-token.txt');
const SERVER_ATTACHMENT_DIR = path.join(DB_DIR, 'DB', 'attachments', 'server-sync');
const DIRECT_CLIENTS_DIR = path.join(DB_DIR, 'direct-sync-clients');
const DIRECT_CLIENT_QUEUE_FILE = 'queue.jsonl';
const DIRECT_QUEUE_CONFIG_FILE = path.join(DB_DIR, 'direct-sync-config.json');
const DISCOVERY_MESSAGE = 'ERP_TASK_MANAGER_DISCOVER_v1';

const SYNC_TABLES = [
  'employees',
  'teams',
  'tasks',
  'subtasks',
  'projects',
  'issues',
  'recurring_tasks',
  'inventory_items',
  'inventory_moves',
  'menu_items',
  'pos_orders',
  'pos_order_items',
  'kot_tickets',
  'task_history',
  'task_comments',
  'task_comment_attachments',
  'task_comment_reads',
  'subtask_comments',
  'subtask_comment_attachments',
  'subtask_comment_reads',
  'issue_comments',
  'issue_comment_attachments',
  'task_attachments',
  'task_reminders',
  'app_settings',
  'user_settings',
  'sync_deletions',
];
const ATTACHMENT_TABLES = new Set([
  'task_attachments',
  'task_comment_attachments',
  'subtask_comment_attachments',
  'issue_comment_attachments',
]);
const DRIVE_ATTACHMENT_MARKER_FILE = path.join(DB_DIR, 'DB', 'drive-uploaded-attachments.json');

function sanitizeFileName(value) {
  return String(value || 'attachment').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180) || 'attachment';
}

function storeUploadedAttachment(table, mutation, data) {
  if (!ATTACHMENT_TABLES.has(table) || (!mutation.fileBase64 && !mutation.directAttachmentPath)) return;
  const rowId = data.id ?? mutation.pkValue ?? Date.now();
  const fileName = sanitizeFileName(mutation.fileName || data.file_name || `attachment-${rowId}`);
  fs.mkdirSync(SERVER_ATTACHMENT_DIR, { recursive: true });
  const savedPath = path.join(SERVER_ATTACHMENT_DIR, `${table}-${sanitizeFileName(rowId)}-${fileName}`);
  if (mutation.directAttachmentPath) {
    const queueFolder = String(mutation.directQueueFolder || '').trim();
    const relativePath = String(mutation.directAttachmentRelativePath || '').trim();
    const sourcePath = relativePath && queueFolder
      ? path.resolve(queueFolder, relativePath)
      : path.resolve(String(mutation.directAttachmentPath || ''));
    const clientsRoot = path.resolve(DIRECT_CLIENTS_DIR);
    const isAllowed = sourcePath !== clientsRoot && sourcePath.startsWith(`${clientsRoot}${path.sep}`);
    if (isAllowed && fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, savedPath);
    } else if (mutation.fileBase64) {
      fs.writeFileSync(savedPath, Buffer.from(String(mutation.fileBase64), 'base64'));
    } else {
      throw new Error(`Queued attachment file is missing or invalid: ${fileName}`);
    }
  } else {
    fs.writeFileSync(savedPath, Buffer.from(String(mutation.fileBase64), 'base64'));
  }
  data.file_path = savedPath;
  if (!data.file_name) data.file_name = fileName;
}

function ensureServerToken() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  if (process.env.ERP_SERVER_TOKEN) return process.env.ERP_SERVER_TOKEN;
  if (!fs.existsSync(TOKEN_FILE)) {
    const token = require('crypto').randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
  }
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

const SERVER_TOKEN = ensureServerToken();
function ensureDirectAccessToken() {
  fs.mkdirSync(DB_DIR, { recursive: true });
  if (process.env.ERP_DIRECT_ACCESS_TOKEN) return process.env.ERP_DIRECT_ACCESS_TOKEN;
  if (!fs.existsSync(DIRECT_ACCESS_TOKEN_FILE)) {
    const token = require('crypto').randomBytes(24).toString('hex');
    fs.writeFileSync(DIRECT_ACCESS_TOKEN_FILE, token, 'utf8');
  }
  return fs.readFileSync(DIRECT_ACCESS_TOKEN_FILE, 'utf8').trim();
}
const DIRECT_ACCESS_TOKEN = ensureDirectAccessToken();
initDatabase(DB_DIR);
const serverEvents = new EventEmitter();
const serverLogs = [];
let server = null;
let discoveryServer = null;
let directQueueTimer = null;
let driveQueueTimer = null;
let driveSnapshotTimer = null;
const processedDriveQueueItemIds = new Set();
let currentPort = BASE_PORT;
let serverState = {
  running: false,
  error: '',
  startedAt: '',
};
const activeLoginSessions = new Map();
const recentConnectionLogs = new Map();

function normalizePort(value, fallback = BASE_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function makeServerState(extra = {}) {
  return {
    running: false,
    error: '',
    startedAt: '',
    portConflict: false,
    existingServer: null,
    suggestedPort: 0,
    ...extra,
  };
}

function addLog(level, message) {
  const entry = {
    ts: new Date().toISOString(),
    level: String(level || 'info'),
    message: String(message || ''),
  };
  serverLogs.push(entry);
  while (serverLogs.length > 500) serverLogs.shift();
  serverEvents.emit('log', entry);
  const writer = entry.level === 'error' ? console.error : entry.level === 'warn' ? console.warn : console.log;
  writer(`[${entry.level}] ${entry.message}`);
}

function getClientAddress(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return String(raw || 'unknown').replace(/^::ffff:/, '');
}

function getClientUserAgent(req) {
  return String(req?.headers?.['user-agent'] || '').trim();
}

function describeClient(req, user = '', clientId = '') {
  const parts = [];
  if (String(user || '').trim()) parts.push(`user "${String(user).trim()}"`);
  if (String(clientId || '').trim()) parts.push(`client ${String(clientId).trim()}`);
  parts.push(`from ${getClientAddress(req)}`);
  const userAgent = getClientUserAgent(req);
  if (userAgent) parts.push(`agent ${userAgent.slice(0, 80)}`);
  return parts.join(', ');
}

function addConnectionLog(level, key, message, dedupeMs = 0) {
  const now = Date.now();
  if (dedupeMs > 0) {
    const previous = recentConnectionLogs.get(key) || 0;
    if (now - previous < dedupeMs) return;
    recentConnectionLogs.set(key, now);
    if (recentConnectionLogs.size > 200) {
      const cutoff = now - 10 * 60 * 1000;
      for (const [entryKey, ts] of recentConnectionLogs.entries()) {
        if (ts < cutoff) recentConnectionLogs.delete(entryKey);
      }
    }
  }
  addLog(level, message);
}

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

function isLocalPortAvailable(port) {
  return new Promise((resolve) => {
    const testServer = http.createServer();
    testServer.once('error', () => resolve(false));
    testServer.once('listening', () => {
      testServer.close(() => resolve(true));
    });
    testServer.listen(port, HOST);
  });
}

function discoverLanServersOnPort(port, timeoutMs = 650) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const servers = new Map();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { socket.close(); } catch {}
      resolve([...servers.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);

    socket.on('message', (message, rinfo) => {
      try {
        const data = JSON.parse(String(message || ''));
        if (data?.role !== 'erp-server') return;
        const serverPort = normalizePort(data.port, port);
        if (serverPort !== port) return;
        const ip = String(data.ip || rinfo.address || '').trim();
        const url = String(data.url || `http://${ip}:${serverPort}`).trim();
        servers.set(url, {
          name: String(data.name || 'ERP Server'),
          ip,
          port: serverPort,
          url,
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
      socket.send(Buffer.from(DISCOVERY_MESSAGE), port, '255.255.255.255', (error) => {
        if (error) {
          clearTimeout(timer);
          finish();
        }
      });
    });
  });
}

async function isServerPortAvailableOnLan(port) {
  const localAvailable = await isLocalPortAvailable(port);
  if (!localAvailable) return { available: false, local: true, server: null };
  const servers = await discoverLanServersOnPort(port);
  return { available: servers.length === 0, local: false, server: servers[0] || null };
}

async function findAvailableServerPort(startPort) {
  for (let port = normalizePort(startPort); port <= 65535 && port < startPort + 50; port += 1) {
    const check = await isServerPortAvailableOnLan(port);
    if (check.available) return port;
  }
  return 0;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function getEmployeeRole(db, actor) {
  const name = String(actor || '').trim();
  if (!name) return '';
  try {
    const row = db.prepare("SELECT COALESCE(role, 'Employee') AS role FROM employees WHERE lower(name)=lower(?) LIMIT 1").get(name);
    return String(row?.role || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function canSeeTask(db, taskId, actor, isAdminFlag = false) {
  const actorName = String(actor || '').trim();
  if (!taskId) return false;
  const task = db.prepare('SELECT assigned_to, assigned_by FROM tasks WHERE task_id=?').get(taskId);
  if (!task) return false;
  const normalized = actorName.toLowerCase();
  const assignedTo = String(task.assigned_to || '').trim().toLowerCase();
  const assignedBy = String(task.assigned_by || '').trim().toLowerCase();
  if (assignedTo && assignedTo === assignedBy && assignedTo !== normalized) return false;
  if (isAdminFlag || ['admin', 'manager'].includes(getEmployeeRole(db, actorName))) return true;
  if ([task.assigned_to, task.assigned_by].map(v => String(v || '').trim().toLowerCase()).includes(normalized)) return true;
  return !!db.prepare("SELECT subtask_id FROM subtasks WHERE task_id=? AND lower(COALESCE(assigned_to, ''))=lower(?) LIMIT 1").get(taskId, actorName);
}

function canDownloadAttachment(db, table, row, actor, isAdminFlag = false) {
  const actorName = String(actor || '').trim();
  if (table === 'task_attachments') {
    const itemId = String(row?.item_id || '').trim();
    const isSubtask = !!Number(row?.is_subtask || 0);
    if (!isSubtask) {
      const task = db.prepare('SELECT task_id FROM tasks WHERE task_id=?').get(itemId);
      if (task) return canSeeTask(db, itemId, actorName, isAdminFlag);
      const issue = db.prepare('SELECT reported_by, assigned_to FROM issues WHERE issue_id=?').get(itemId);
      if (issue) {
        if (isAdminFlag || ['admin', 'manager'].includes(getEmployeeRole(db, actorName))) return true;
        const normalized = actorName.toLowerCase();
        return [issue.reported_by, issue.assigned_to].map(v => String(v || '').trim().toLowerCase()).includes(normalized);
      }
      const project = db.prepare('SELECT owner_name, team_name FROM projects WHERE project_id=?').get(itemId);
      if (project) {
        if (isAdminFlag || ['admin', 'manager'].includes(getEmployeeRole(db, actorName))) return true;
        const direct = String(project.owner_name || '').trim().toLowerCase() === actorName.toLowerCase();
        if (direct) return true;
        const emp = db.prepare("SELECT name FROM employees WHERE lower(name)=lower(?) AND lower(COALESCE(team_name, ''))=lower(?)").get(actorName, String(project.team_name || '').trim());
        return !!emp;
      }
      return false;
    }
    const subtask = db.prepare(`
      SELECT s.task_id, s.assigned_to, t.assigned_to AS task_assigned_to, t.assigned_by AS task_assigned_by
      FROM subtasks s
      LEFT JOIN tasks t ON t.task_id=s.task_id
      WHERE s.subtask_id=?
    `).get(itemId);
    if (canSeeTask(db, subtask?.task_id, actorName, isAdminFlag)) return true;
    const normalized = actorName.toLowerCase();
    return !!subtask && [subtask.assigned_to, subtask.task_assigned_to, subtask.task_assigned_by]
      .map(v => String(v || '').trim().toLowerCase())
      .includes(normalized);
  }
  if (table === 'task_comment_attachments') {
    const comment = db.prepare('SELECT task_id FROM task_comments WHERE id=?').get(row?.comment_id);
    return canSeeTask(db, comment?.task_id, actorName, isAdminFlag);
  }
  if (isAdminFlag || ['admin', 'manager'].includes(getEmployeeRole(db, actorName))) return true;
  if (table === 'issue_comment_attachments') {
    const comment = db.prepare(`
      SELECT i.reported_by, i.assigned_to
      FROM issue_comment_attachments a
      JOIN issue_comments c ON c.id=a.comment_id
      JOIN issues i ON i.issue_id=c.issue_id
      WHERE a.id=?
    `).get(row?.id);
    const normalized = actorName.toLowerCase();
    return !!comment && [comment.reported_by, comment.assigned_to].map(v => String(v || '').trim().toLowerCase()).includes(normalized);
  }
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100_000_000) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(req) {
  const header = String(req.headers.authorization || '');
  return header === `Bearer ${SERVER_TOKEN}`;
}

function getSnapshot() {
  const db = getDatabase();
  const snapshot = {};
  for (const table of SYNC_TABLES) {
    try {
      snapshot[table] = db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      snapshot[table] = [];
    }
  }
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    tables: snapshot,
  };
}

function registerLoginSession(user, clientId, force = false) {
  const userName = String(user || '').trim();
  const normalized = userName.toLowerCase();
  const cleanClientId = String(clientId || '').trim();
  if (!userName || !cleanClientId) return { ok: false, error: 'User and client are required.' };
  const existing = activeLoginSessions.get(normalized);
  const now = new Date().toISOString();
  if (existing && existing.clientId !== cleanClientId && !force) {
    return {
      ok: false,
      multipleSignIn: true,
      error: 'Multiple sign-in detected. This user is already signed in on another client. Use here?',
      activeSince: existing.signedInAt || '',
    };
  }
  activeLoginSessions.set(normalized, { user: userName, clientId: cleanClientId, signedInAt: existing?.signedInAt || now, lastSeenAt: now });
  return { ok: true, user: userName };
}

function releaseLoginSession(user, clientId) {
  const normalized = String(user || '').trim().toLowerCase();
  const cleanClientId = String(clientId || '').trim();
  const existing = activeLoginSessions.get(normalized);
  if (existing && (!cleanClientId || existing.clientId === cleanClientId)) {
    activeLoginSessions.delete(normalized);
  }
  return { ok: true };
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(col => col.name);
}

function checkpointServerDb(db = getDatabase()) {
  try {
    db?.pragma?.('wal_checkpoint(FULL)');
  } catch {}
}

function applyMutation(db, mutation, actor) {
  const table = String(mutation.table || '').trim();
  const action = String(mutation.action || '').trim();
  const data = mutation.data && typeof mutation.data === 'object' ? mutation.data : {};
  if (!SYNC_TABLES.includes(table)) throw new Error(`Table is not syncable: ${table}`);
  if (!['insert', 'update', 'delete'].includes(action)) throw new Error(`Unsupported action: ${action}`);
  storeUploadedAttachment(table, mutation, data);

  const columns = tableColumns(db, table);
  const requestedPk = Array.isArray(mutation.pk) ? mutation.pk : [mutation.pk || columns[0]];
  const pkColumns = requestedPk.map(col => String(col || '')).filter(col => columns.includes(col));
  if (!pkColumns.length) pkColumns.push(columns[0]);
  const pkValues = Array.isArray(mutation.pkValue)
    ? mutation.pkValue
    : pkColumns.map((col, index) => (index === 0 ? (data[col] ?? mutation.pkValue) : data[col]));
  if (pkColumns.some((col, index) => !col || pkValues[index] === undefined || pkValues[index] === null || pkValues[index] === '')) {
    throw new Error(`Missing primary key for ${table}.`);
  }

  const whereSql = pkColumns.map(col => `${col}=?`).join(' AND ');
  const isSystemAdminEmployee = table === 'employees' && pkColumns.length === 1 && pkColumns[0] === 'name' && String(pkValues[0] || '').trim().toLowerCase() === SYSTEM_ADMIN_NAME.toLowerCase();
  if (isSystemAdminEmployee && action === 'delete') {
    ensureSystemAdmin(db);
    return { ok: true, skipped: true, warning: 'Built-in Admin cannot be deleted.', table, pkValue: SYSTEM_ADMIN_NAME };
  }
  if (isSystemAdminEmployee) {
    data.name = SYSTEM_ADMIN_NAME;
    if (columns.includes('role')) data.role = 'Admin';
    if (columns.includes('team_name')) data.team_name = '';
    if (columns.includes('team')) data.team = '';
  }
  const existing = db.prepare(`SELECT * FROM ${table} WHERE ${whereSql}`).get(...pkValues);
  if (table === 'employees' && action !== 'delete') {
    const requestedRole = String(data.role || data.designation || '').trim().toLowerCase();
    const existingRole = String(existing?.role || existing?.designation || '').trim().toLowerCase();
    if ((requestedRole === 'admin' || existingRole === 'admin') && getEmployeeRole(db, actor) !== 'admin') {
      throw new Error('Only Admin can add or modify Admin users.');
    }
  }
  const requestedAt = Number(new Date(mutation.changedAt || mutation.clientTime || Date.now()).getTime());
  const existingAt = Number(new Date(existing?.updated_on || existing?.last_updated || existing?.changed_on || existing?.date_assigned || 0).getTime());
  const contradiction = !!existing && action !== 'delete' && Number.isFinite(existingAt) && existingAt > requestedAt;

  if (contradiction) {
    return {
      ok: true,
      skipped: true,
      warning: `Contradiction detected for ${table}/${pkValues.join('/')}. Server has newer data, so the newer time-based version was kept.`,
      serverRow: existing,
      notifyUser: actor || '',
    };
  }

  if (action === 'delete') {
    const deletedAt = mutation.changedAt || mutation.clientTime || new Date().toISOString();
    if (table === 'tasks') cascadeTaskDelete(db, pkValues[0], actor, deletedAt);
    recordDeletionTombstone(db, table, pkColumns, pkValues, actor, deletedAt);
    db.prepare(`DELETE FROM ${table} WHERE ${whereSql}`).run(...pkValues);
    return { ok: true, action, table, pkValue: pkValues.join('/') };
  }

  const writeColumns = columns.filter(col => Object.prototype.hasOwnProperty.call(data, col));
  if (!writeColumns.length) throw new Error(`No writable fields for ${table}/${pkValues.join('/')}.`);

  if (action === 'insert' || !existing) {
    const placeholders = writeColumns.map(() => '?').join(', ');
    db.prepare(`INSERT OR REPLACE INTO ${table} (${writeColumns.join(', ')}) VALUES (${placeholders})`)
      .run(...writeColumns.map(col => data[col]));
  } else {
    const setSql = writeColumns.filter(col => !pkColumns.includes(col)).map(col => `${col}=?`).join(', ');
    if (setSql) {
      db.prepare(`UPDATE ${table} SET ${setSql} WHERE ${whereSql}`)
        .run(...writeColumns.filter(col => !pkColumns.includes(col)).map(col => data[col]), ...pkValues);
    }
  }

  return { ok: true, action, table, pkValue: pkValues.join('/') };
}

function getDirectQueuePollSeconds() {
  const envValue = Number.parseInt(process.env.ERP_DIRECT_QUEUE_POLL_SECONDS, 10);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;
  const cfg = readDirectSyncConfig();
  const configuredFromFile = Number.parseInt(cfg?.pollSeconds, 10);
  if (Number.isFinite(configuredFromFile) && configuredFromFile > 0) return configuredFromFile;
  try {
    const db = getDatabase();
    const row = db.prepare("SELECT value FROM app_settings WHERE key='directQueuePollSeconds'").get();
    const parsed = row ? JSON.parse(row.value) : '';
    const configured = Number.parseInt(parsed, 10);
    if (Number.isFinite(configured) && configured > 0) return configured;
  } catch {}
  return 10;
}

function readDirectSyncConfig() {
  try {
    if (fs.existsSync(DIRECT_QUEUE_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(DIRECT_QUEUE_CONFIG_FILE, 'utf8'));
      return cfg && typeof cfg === 'object' ? cfg : {};
    }
  } catch {}
  return {};
}

function getDriveSyncConfig() {
  const cfg = readDirectSyncConfig();
  return {
    driveScriptUrl: normalizeDriveScriptUrl(cfg.driveScriptUrl || process.env.ERP_DRIVE_SCRIPT_URL || ''),
    driveToken: String(cfg.driveToken || process.env.ERP_DRIVE_TOKEN || '').trim(),
  };
}

function isDriveSyncConfigured() {
  const cfg = getDriveSyncConfig();
  return !!cfg.driveScriptUrl && !!cfg.driveToken;
}

function getServerDbPath() {
  return path.join(DB_DIR, 'erp_tasks.db');
}

const BUSINESS_SYNC_TABLES = SYNC_TABLES.filter(table => !['app_settings', 'user_settings', 'sync_deletions'].includes(table));

function countServerBusinessRows(db = getDatabase()) {
  let count = 0;
  for (const table of BUSINESS_SYNC_TABLES) {
    try {
      if (table === 'employees') {
        const row = db.prepare('SELECT COUNT(*) AS count FROM employees WHERE LOWER(name) != ?').get(SYSTEM_ADMIN_NAME.toLowerCase());
        count += Number(row?.count || 0);
      } else {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
        count += Number(row?.count || 0);
      }
    } catch {}
  }
  return count;
}

function remoteTableExists(remoteDb, table) {
  try {
    return !!remoteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function deletionId(table, pkColumns, pkValues) {
  return `${String(table || '')}:${pkColumns.map(String).join('+')}:${pkValues.map(value => encodeURIComponent(String(value ?? ''))).join('+')}`;
}

function recordDeletionTombstone(db, table, pkColumns, pkValues, actor, deletedAt = new Date().toISOString()) {
  if (table === 'sync_deletions') return;
  try {
    const pk = pkColumns.map(String).join(',');
    const pkValue = pkValues.map(value => String(value ?? '')).join('\u001f');
    db.prepare(`
      INSERT OR REPLACE INTO sync_deletions (id, table_name, pk, pk_value, deleted_at, deleted_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(deletionId(table, pkColumns, pkValues), table, pk, pkValue, deletedAt, String(actor || 'system'));
  } catch {}
}

function hasDeletionTombstone(db, table, pkColumns, pkValues) {
  try {
    return !!db.prepare('SELECT id FROM sync_deletions WHERE id=?').get(deletionId(table, pkColumns, pkValues));
  } catch {
    return false;
  }
}

function deleteRowsWithTombstones(db, table, pk, rows, actor, deletedAt) {
  for (const row of rows || []) {
    const value = row?.[pk];
    if (value === undefined || value === null || value === '') continue;
    recordDeletionTombstone(db, table, [pk], [value], actor, deletedAt);
    try {
      db.prepare(`DELETE FROM ${table} WHERE ${pk}=?`).run(value);
    } catch {}
  }
}

function cascadeTaskDelete(db, taskId, actor, deletedAt) {
  const subtaskRows = db.prepare('SELECT subtask_id FROM subtasks WHERE task_id=?').all(taskId);
  const subtaskIds = subtaskRows.map(row => row.subtask_id).filter(Boolean);
  const taskCommentRows = db.prepare('SELECT id FROM task_comments WHERE task_id=?').all(taskId);
  const taskCommentIds = taskCommentRows.map(row => row.id).filter(value => value !== undefined && value !== null);
  const taskAttachmentRows = db.prepare('SELECT id FROM task_attachments WHERE item_id=? AND is_subtask=0').all(taskId);
  const taskReminderRows = db.prepare('SELECT id FROM task_reminders WHERE item_id=? AND is_subtask=0').all(taskId);

  if (taskCommentIds.length) {
    const placeholders = taskCommentIds.map(() => '?').join(',');
    deleteRowsWithTombstones(db, 'task_comment_attachments', 'id', db.prepare(`SELECT id FROM task_comment_attachments WHERE comment_id IN (${placeholders})`).all(...taskCommentIds), actor, deletedAt);
    deleteRowsWithTombstones(db, 'task_comment_reads', 'id', db.prepare(`SELECT id FROM task_comment_reads WHERE comment_id IN (${placeholders})`).all(...taskCommentIds), actor, deletedAt);
  }
  deleteRowsWithTombstones(db, 'task_comments', 'id', taskCommentRows, actor, deletedAt);
  deleteRowsWithTombstones(db, 'task_attachments', 'id', taskAttachmentRows, actor, deletedAt);
  deleteRowsWithTombstones(db, 'task_reminders', 'id', taskReminderRows, actor, deletedAt);

  if (subtaskIds.length) {
    const placeholders = subtaskIds.map(() => '?').join(',');
    const subtaskCommentRows = db.prepare(`SELECT id FROM subtask_comments WHERE subtask_id IN (${placeholders})`).all(...subtaskIds);
    const subtaskCommentIds = subtaskCommentRows.map(row => row.id).filter(value => value !== undefined && value !== null);
    if (subtaskCommentIds.length) {
      const commentPlaceholders = subtaskCommentIds.map(() => '?').join(',');
      deleteRowsWithTombstones(db, 'subtask_comment_attachments', 'id', db.prepare(`SELECT id FROM subtask_comment_attachments WHERE comment_id IN (${commentPlaceholders})`).all(...subtaskCommentIds), actor, deletedAt);
      deleteRowsWithTombstones(db, 'subtask_comment_reads', 'id', db.prepare(`SELECT id FROM subtask_comment_reads WHERE comment_id IN (${commentPlaceholders})`).all(...subtaskCommentIds), actor, deletedAt);
    }
    deleteRowsWithTombstones(db, 'subtask_comments', 'id', subtaskCommentRows, actor, deletedAt);
    deleteRowsWithTombstones(db, 'task_attachments', 'id', db.prepare(`SELECT id FROM task_attachments WHERE is_subtask=1 AND item_id IN (${placeholders})`).all(...subtaskIds), actor, deletedAt);
    deleteRowsWithTombstones(db, 'task_reminders', 'id', db.prepare(`SELECT id FROM task_reminders WHERE is_subtask=1 AND item_id IN (${placeholders})`).all(...subtaskIds), actor, deletedAt);
  }
  deleteRowsWithTombstones(db, 'subtasks', 'subtask_id', subtaskRows, actor, deletedAt);
}

function countRemoteBusinessRows(remoteDb) {
  return BUSINESS_SYNC_TABLES.reduce((sum, table) => {
    try {
      if (!remoteTableExists(remoteDb, table)) return sum;
      if (table === 'employees') {
        const row = remoteDb.prepare('SELECT COUNT(*) AS count FROM employees WHERE LOWER(name) != ?').get(SYSTEM_ADMIN_NAME.toLowerCase());
        return sum + Number(row?.count || 0);
      }
      const row = remoteDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return sum + Number(row?.count || 0);
    } catch {
      return sum;
    }
  }, 0);
}

function mergeMissingRowsFromSnapshot(localDb, remoteDb, table) {
  if (!remoteTableExists(remoteDb, table)) return 0;
  const columns = tableColumns(localDb, table);
  if (!columns.length) return 0;
  const rows = remoteDb.prepare(`SELECT * FROM ${table}`).all();
  const pkInfo = localDb.prepare(`PRAGMA table_info(${table})`).all().filter(col => Number(col.pk || 0) > 0).sort((a, b) => Number(a.pk || 0) - Number(b.pk || 0));
  const pkColumns = pkInfo.length ? pkInfo.map(col => col.name) : [columns[0]];
  let inserted = 0;
  const tx = localDb.transaction(() => {
    for (const row of rows) {
      const insertColumns = columns.filter(col => Object.prototype.hasOwnProperty.call(row, col));
      if (!insertColumns.length) continue;
      if (table !== 'sync_deletions') {
        const pkValues = pkColumns.map(col => row[col]);
        if (pkValues.every(value => value !== undefined && value !== null && value !== '') && hasDeletionTombstone(localDb, table, pkColumns, pkValues)) {
          continue;
        }
      }
      const placeholders = insertColumns.map(() => '?').join(', ');
      const info = localDb.prepare(`INSERT OR IGNORE INTO ${table} (${insertColumns.join(', ')}) VALUES (${placeholders})`)
        .run(...insertColumns.map(col => row[col]));
      inserted += Number(info?.changes || 0);
    }
  });
  tx();
  return inserted;
}

async function mergeServerDbFromDriveSnapshot(cfg, reason = 'drive-queue', options = {}) {
  const localDb = getDatabase();
  const localRowsBefore = countServerBusinessRows(localDb);
  let snapshot;
  try {
    snapshot = await appsScriptGet(cfg.driveScriptUrl, cfg.driveToken, 'snapshot');
  } catch (error) {
    addLog('warn', `Drive DB merge skipped (${reason}): ${error?.message || error}`);
    return { ok: false, skipped: true, error: String(error?.message || error) };
  }
  if (!snapshot?.base64) return { ok: true, skipped: true };
  const tempPath = path.join(DB_DIR, `drive-hydrate-${process.pid}-${Date.now()}.db`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(String(snapshot.base64 || ''), 'base64'));
    const remoteDb = new Database(tempPath, { readonly: true, fileMustExist: true });
    let insertedRows = 0;
    try {
      const remoteRows = countRemoteBusinessRows(remoteDb);
      if (remoteRows <= 0) return { ok: true, skipped: true };
      if (options.onlyWhenLocalIsEmpty && localRowsBefore > 0) return { ok: true, skipped: true };
      const orderedTables = ['sync_deletions', ...SYNC_TABLES.filter(table => table !== 'sync_deletions')];
      for (const table of orderedTables) insertedRows += mergeMissingRowsFromSnapshot(localDb, remoteDb, table);
      ensureSystemAdmin(localDb);
      checkpointServerDb(localDb);
      if (insertedRows > 0) {
        addLog('info', `Merged ${insertedRows} missing row${insertedRows === 1 ? '' : 's'} from Drive snapshot before ${reason}.`);
      }
      return { ok: true, merged: insertedRows > 0, insertedRows, localRowsBefore, remoteRows };
    } finally {
      remoteDb.close();
    }
  } catch (error) {
    addLog('warn', `Drive DB merge failed (${reason}): ${error?.message || error}`);
    return { ok: false, error: String(error?.message || error) };
  } finally {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

// Tracks which attachments have already been uploaded to Drive, keyed by
// table:id, with the value being a size+mtime fingerprint of the file at
// upload time — so a replaced attachment (same row id, different file
// content) gets re-uploaded, but an unchanged one doesn't get re-sent on
// every single snapshot cycle.
function readDriveAttachmentMarkers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DRIVE_ATTACHMENT_MARKER_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeDriveAttachmentMarkers(markers) {
  try {
    fs.mkdirSync(path.dirname(DRIVE_ATTACHMENT_MARKER_FILE), { recursive: true });
    fs.writeFileSync(DRIVE_ATTACHMENT_MARKER_FILE, JSON.stringify(markers || {}, null, 2), 'utf8');
  } catch (error) {
    writeCrashLog('drive-attachment-marker-write-failed', error);
  }
}

// This is the piece that was missing entirely: uploadDriveSnapshotNow below
// only ever pushed the database file itself. The DB does carry attachment
// *rows* (file name, the local path on this machine), which is why tasks
// always looked correctly updated on Drive — but nothing ever copied the
// actual attachment *file contents* there for anything added on the
// server/LAN side, so a Remote client's later attempt to fetch one found
// nothing, regardless of what the task/DB said. Client-uploaded attachments
// already worked, via a completely separate path (embedded directly in
// their queued mutation) — this is the missing other direction.
async function uploadMissingAttachmentsToDrive(cfg) {
  if (!cfg.driveScriptUrl || !cfg.driveToken) return { ok: true, skipped: true, uploaded: 0, failed: 0 };
  const db = getDatabase();
  if (!db) return { ok: true, skipped: true, uploaded: 0, failed: 0 };
  const markers = readDriveAttachmentMarkers();
  let uploaded = 0;
  let failed = 0;
  for (const table of ATTACHMENT_TABLES) {
    let rows;
    try {
      rows = db.prepare(`SELECT id, file_name, file_path FROM ${table} WHERE COALESCE(file_path,'') != ''`).all();
    } catch {
      continue; // table may not exist in this schema variant — skip, not fatal
    }
    for (const row of rows) {
      const filePath = String(row.file_path || '');
      if (!filePath || !fs.existsSync(filePath)) continue;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const markerKey = `${table}:${row.id}`;
      const markerValue = `${stat.size}-${Math.round(stat.mtimeMs)}`;
      if (markers[markerKey] === markerValue) continue;
      try {
        await appsScriptPost(cfg.driveScriptUrl, cfg.driveToken, {
          action: 'uploadAttachment',
          table,
          id: String(row.id),
          fileName: row.file_name || path.basename(filePath),
          base64: readFileBase64(filePath),
        });
        markers[markerKey] = markerValue;
        uploaded += 1;
      } catch (error) {
        failed += 1;
        addLog('warn', `Drive attachment upload failed (${table}:${row.id}, ${row.file_name || ''}): ${String(error?.message || error)}`);
      }
    }
  }
  writeDriveAttachmentMarkers(markers);
  if (uploaded || failed) {
    addLog('info', `Drive attachment sync: ${uploaded} uploaded${failed ? `, ${failed} failed` : ''}.`);
  }
  return { ok: failed === 0, uploaded, failed };
}

async function uploadDriveSnapshotNow(reason = 'manual', options = {}) {
  const cfg = getDriveSyncConfig();
  if (!cfg.driveScriptUrl || !cfg.driveToken) {
    addLog('info', `Drive DB snapshot upload skipped (${reason}): Drive Web sync is not configured.`);
    return { ok: true, skipped: true };
  }
  const db = getDatabase();
  if (!options.skipMerge && !String(reason || '').startsWith('merge-')) {
    await mergeServerDbFromDriveSnapshot(cfg, `upload-${reason}`);
  }
  checkpointServerDb(db);
  const dbPath = getServerDbPath();
  if (!fs.existsSync(dbPath)) {
    const error = `DB file not found: ${dbPath}`;
    addLog('warn', `Drive DB snapshot upload failed (${reason}): ${error}`);
    return { ok: false, error };
  }
  try {
    const result = await appsScriptPost(cfg.driveScriptUrl, cfg.driveToken, {
      action: 'uploadSnapshot',
      fileName: 'erp_tasks.db',
      reason,
      base64: readFileBase64(dbPath),
    });
    const target = result?.fileName ? ` to ${result.fileName}` : '';
    const mode = result?.snapshotMode ? ` using ${result.snapshotMode}` : '';
    addLog('info', `Drive DB snapshot upload successful${reason ? ` (${reason})` : ''}${target}${mode}.`);
    try {
      await uploadMissingAttachmentsToDrive(cfg);
    } catch (attachmentError) {
      // Don't let an attachment-upload problem mask the fact that the DB
      // snapshot itself (the part this function is named for) did succeed.
      writeCrashLog('drive-attachment-sync-failed', attachmentError);
    }
    return result;
  } catch (error) {
    const message = String(error?.message || error);
    const hint = /Access denied:\s*DriveApp/i.test(message)
      ? ' Check Apps Script deployment is Execute as: Me and that the script owner can edit the Drive folder.'
      : '';
    addLog('warn', `Drive DB snapshot upload failed${reason ? ` (${reason})` : ''}: ${message}${hint}`);
    throw error;
  }
}

async function syncDriveSnapshotOnServerStart() {
  const cfg = getDriveSyncConfig();
  if (!cfg.driveScriptUrl || !cfg.driveToken) return { ok: true, skipped: true };
  const mergeResult = await mergeServerDbFromDriveSnapshot(cfg, 'server-start');
  if (mergeResult?.ok && !mergeResult?.skipped) {
    addLog('info', 'Drive DB snapshot fetched before server start upload.');
  }
  return uploadDriveSnapshotNow('server-start', { skipMerge: true });
}

function scheduleDriveSnapshotUpload(reason = 'change') {
  if (!isDriveSyncConfigured()) return;
  if (driveSnapshotTimer) clearTimeout(driveSnapshotTimer);
  driveSnapshotTimer = setTimeout(() => {
    driveSnapshotTimer = null;
    uploadDriveSnapshotNow(reason).catch(() => {});
  }, 1500);
}

function writeDirectSyncConfig(config = {}) {
  const queuePollSeconds = Math.max(1, Number.parseInt(config.pollSeconds, 10) || getDirectQueuePollSeconds() || 10);
  const current = readDirectSyncConfig();
  const next = {
    ...current,
    pollSeconds: queuePollSeconds,
    driveScriptUrl: Object.prototype.hasOwnProperty.call(config, 'driveScriptUrl') ? normalizeDriveScriptUrl(config.driveScriptUrl) : normalizeDriveScriptUrl(current.driveScriptUrl || ''),
    driveToken: Object.prototype.hasOwnProperty.call(config, 'driveToken') && String(config.driveToken || '').trim()
      ? String(config.driveToken || '').trim()
      : String(current.driveToken || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.writeFileSync(DIRECT_QUEUE_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  scheduleDirectQueuePolling();
  scheduleDriveQueuePolling();
  addLog('info', `Remote access queue poll interval updated: ${queuePollSeconds}s.`);
  return getRemoteAccessConfig();
}

function getRemoteAccessConfig() {
  return {
    ok: true,
    directQueueConfigFile: DIRECT_QUEUE_CONFIG_FILE,
    directQueuePollSeconds: getDirectQueuePollSeconds(),
    directClientQueueDir: DIRECT_CLIENTS_DIR,
    directAccessTokenFile: DIRECT_ACCESS_TOKEN_FILE,
    directAccessToken: DIRECT_ACCESS_TOKEN,
    driveScriptUrl: getDriveSyncConfig().driveScriptUrl,
    driveToken: getDriveSyncConfig().driveToken,
    driveTokenConfigured: !!getDriveSyncConfig().driveToken,
  };
}

function listDirectQueueFiles() {
  const files = [];
  try {
    if (fs.existsSync(DIRECT_CLIENTS_DIR)) {
      for (const entry of fs.readdirSync(DIRECT_CLIENTS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const queuePath = path.join(DIRECT_CLIENTS_DIR, entry.name, DIRECT_CLIENT_QUEUE_FILE);
        if (fs.existsSync(queuePath)) files.push(queuePath);
      }
    }
  } catch {}
  return files;
}

function appendDirectQueueItems(queuePath, items) {
  if (!Array.isArray(items) || !items.length) return;
  if (!queuePath) return;
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.appendFileSync(queuePath, items.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
}

function cleanupProcessedDirectAttachments(mutations, queueFolder = '') {
  const clientsRoot = path.resolve(DIRECT_CLIENTS_DIR);
  for (const mutation of mutations || []) {
    const relativePath = String(mutation?.directAttachmentRelativePath || '').trim();
    const sourcePath = relativePath && queueFolder
      ? path.resolve(queueFolder, relativePath)
      : path.resolve(String(mutation?.directAttachmentPath || ''));
    const allowed = sourcePath !== clientsRoot && sourcePath.startsWith(`${clientsRoot}${path.sep}`);
    if (!sourcePath || !allowed) continue;
    try { fs.unlinkSync(sourcePath); } catch {}
  }
}

function processDirectQueueFile(queuePath) {
  if (!queuePath || !fs.existsSync(queuePath)) return { ok: true, processed: 0 };
  const processingPath = path.join(path.dirname(queuePath), `${path.basename(queuePath, '.jsonl')}-processing-${Date.now()}.jsonl`);
  try {
    fs.renameSync(queuePath, processingPath);
  } catch (error) {
    return { ok: false, error: String(error?.message || error), processed: 0 };
  }
  const retryItems = [];
  let processed = 0;
  try {
    const lines = fs.readFileSync(processingPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const db = getDatabase();
    const queueFolder = path.dirname(processingPath);
    for (const line of lines) {
      let item = null;
      try {
        item = JSON.parse(line);
        const actor = String(item?.actor || 'system');
        const mutations = Array.isArray(item?.mutations)
          ? item.mutations.map(mutation => ({ ...mutation, directQueueFolder: queueFolder }))
          : [];
        db.transaction(() => mutations.map(mutation => applyMutation(db, mutation, actor)))();
        checkpointServerDb(db);
        scheduleDriveSnapshotUpload('direct-queue');
        cleanupProcessedDirectAttachments(mutations, queueFolder);
        processed += 1;
      } catch (error) {
        if (item) retryItems.push({ ...item, lastError: String(error?.message || error), lastTriedAt: new Date().toISOString() });
        addLog('warn', `Direct DB queued mutation failed: ${error?.message || error}`);
      }
    }
  } finally {
    try { fs.unlinkSync(processingPath); } catch {}
  }
  if (retryItems.length) appendDirectQueueItems(queuePath, retryItems);
  if (processed) addLog('info', `Applied ${processed} direct DB queued change${processed === 1 ? '' : 's'} from ${path.basename(queuePath)}.`);
  return { ok: true, processed, retried: retryItems.length };
}

function pollDirectQueueOnce() {
  const queueFiles = listDirectQueueFiles();
  if (!queueFiles.length) return { ok: true, processed: 0 };
  let processed = 0;
  let retried = 0;
  const errors = [];
  for (const queuePath of queueFiles) {
    const result = processDirectQueueFile(queuePath);
    processed += Number(result.processed || 0);
    retried += Number(result.retried || 0);
    if (!result.ok && result.error) errors.push(`${path.basename(queuePath)}: ${result.error}`);
  }
  return { ok: errors.length === 0, processed, retried, error: errors.join('; ') };
}

function getDriveQueueText(queue) {
  if (!queue) return '';
  if (typeof queue.text === 'string') return queue.text;
  if (typeof queue.content === 'string') return queue.content;
  if (typeof queue.base64 === 'string') return Buffer.from(queue.base64, 'base64').toString('utf8');
  if (Array.isArray(queue.items)) return queue.items.map(item => JSON.stringify(item)).join('\n');
  return '';
}

async function processDriveQueueFile(file) {
  const cfg = getDriveSyncConfig();
  if (!cfg.driveScriptUrl || !cfg.driveToken || !file?.fileId) return { ok: true, processed: 0 };
  const queue = await appsScriptGet(cfg.driveScriptUrl, cfg.driveToken, 'queue', { fileId: file.fileId });
  const lines = getDriveQueueText(queue).split(/\r?\n/).filter(Boolean);
  const retryItems = [];
  let processed = 0;
  const db = getDatabase();
  for (const line of lines) {
    let item = null;
    try {
      item = JSON.parse(line);
      const itemId = String(item?.id || `${file.fileId}:${line}`).trim();
      if (processedDriveQueueItemIds.has(itemId)) continue;
      const actor = String(item?.actor || 'system');
      const mutations = Array.isArray(item?.mutations) ? item.mutations : [];
      db.transaction(() => mutations.map(mutation => applyMutation(db, mutation, actor)))();
      checkpointServerDb(db);
      processedDriveQueueItemIds.add(itemId);
      if (processedDriveQueueItemIds.size > 5000) processedDriveQueueItemIds.clear();
      processed += 1;
    } catch (error) {
      if (item) retryItems.push({ ...item, lastError: String(error?.message || error), lastTriedAt: new Date().toISOString() });
      addLog('warn', `Drive queued mutation failed: ${error?.message || error}`);
    }
  }
  try {
    await appsScriptPost(cfg.driveScriptUrl, cfg.driveToken, {
      action: retryItems.length ? 'replaceQueue' : 'markQueueProcessed',
      fileId: file.fileId,
      items: retryItems,
    });
  } catch (error) {
    addLog('warn', `Drive queue cleanup failed for ${file.fileName || file.fileId}: ${error?.message || error}`);
  }
  if (processed) {
    addLog('info', `Applied ${processed} Drive queued change${processed === 1 ? '' : 's'} from ${file.fileName || file.fileId}.`);
    scheduleDriveSnapshotUpload('drive-queue');
  } else if (retryItems.length) {
    addLog('warn', `Drive queue file ${file.fileName || file.fileId} has ${retryItems.length} failed queued change${retryItems.length === 1 ? '' : 's'} pending retry.`);
  }
  return { ok: true, processed, retried: retryItems.length };
}

async function pollDriveQueueOnce() {
  const cfg = getDriveSyncConfig();
  if (!cfg.driveScriptUrl || !cfg.driveToken) return { ok: true, skipped: true, processed: 0 };
  const startedAt = new Date();
  const list = await appsScriptGet(cfg.driveScriptUrl, cfg.driveToken, 'listQueues');
  const files = Array.isArray(list.files) ? list.files : Array.isArray(list.queues) ? list.queues : [];
  addLog('info', files.length
    ? `Drive sync check started: ${files.length} queue file${files.length === 1 ? '' : 's'} found.`
    : 'Drive sync check started.');
  if (files.length) await mergeServerDbFromDriveSnapshot(cfg, 'drive-queue');
  let processed = 0;
  let retried = 0;
  const errors = [];
  for (const file of files) {
    try {
      const result = await processDriveQueueFile(file);
      processed += Number(result.processed || 0);
      retried += Number(result.retried || 0);
    } catch (error) {
      errors.push(`${file.fileName || file.fileId || 'queue'}: ${error?.message || error}`);
    }
  }
  if (errors.length) addLog('warn', `Drive queue poll errors: ${errors.join('; ')}`);
  const elapsedMs = Date.now() - startedAt.getTime();
  if (!files.length) {
    addLog('info', 'Drive sync check complete.');
  } else if (processed > 0) {
    addLog('info', `Drive sync check complete: ${processed} queued change${processed === 1 ? '' : 's'} applied, DB snapshot upload scheduled (${elapsedMs}ms).`);
  } else if (retried > 0 || errors.length) {
    addLog('warn', `Drive sync check complete: no changes applied, ${retried} queued change${retried === 1 ? '' : 's'} pending retry (${elapsedMs}ms).`);
  } else {
    addLog('info', `Drive sync check complete: queue files already processed, DB snapshot upload skipped (${elapsedMs}ms).`);
  }
  return { ok: errors.length === 0, processed, retried, error: errors.join('; ') };
}

function scheduleDirectQueuePolling() {
  if (directQueueTimer) {
    clearTimeout(directQueueTimer);
    directQueueTimer = null;
  }
  const seconds = getDirectQueuePollSeconds();
  directQueueTimer = setTimeout(() => {
    pollDirectQueueOnce();
    scheduleDirectQueuePolling();
  }, Math.max(1, seconds) * 1000);
}

function scheduleDriveQueuePolling() {
  if (driveQueueTimer) {
    clearTimeout(driveQueueTimer);
    driveQueueTimer = null;
  }
  if (!isDriveSyncConfigured()) return;
  const seconds = getDirectQueuePollSeconds();
  driveQueueTimer = setTimeout(() => {
    pollDriveQueueOnce().catch(error => addLog('warn', `Drive queue poll failed: ${error?.message || error}`));
    scheduleDriveQueuePolling();
  }, Math.max(1, seconds) * 1000);
}

function createHttpServer() {
  return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, role: 'erp-server', serverTime: new Date().toISOString() });
    }

    if (!isAuthorized(req)) {
      addConnectionLog(
        'warn',
        `unauthorized:${getClientAddress(req)}:${url.pathname}`,
        `Client connection rejected: unauthorized request to ${url.pathname} from ${getClientAddress(req)}.`,
        5000
      );
      return sendJson(res, 401, { ok: false, error: 'Unauthorized.' });
    }

    if (req.method === 'GET' && url.pathname === '/api/auth-check') {
      addConnectionLog(
        'info',
        `auth-check:${getClientAddress(req)}`,
        `Client connected to server: ${describeClient(req)}.`,
        60000
      );
      return sendJson(res, 200, { ok: true, role: 'erp-server', serverTime: new Date().toISOString() });
    }

    if (req.method === 'POST' && url.pathname === '/api/login-session') {
      const body = await readJson(req);
      const result = registerLoginSession(body.user, body.clientId, body.force);
      if (result.ok) {
        addLog('info', `Client user session connected: ${describeClient(req, body.user, body.clientId)}.`);
      } else {
        addLog('warn', `Client connection blocked: ${describeClient(req, body.user, body.clientId)}. ${result.error || 'Unknown error'}`);
      }
      return sendJson(res, result.ok ? 200 : 409, result);
    }

    if (req.method === 'POST' && url.pathname === '/api/login-session/logout') {
      const body = await readJson(req);
      const result = releaseLoginSession(body.user, body.clientId);
      addLog('info', `Client disconnected: ${describeClient(req, body.user, body.clientId)}.`);
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      return sendJson(res, 200, getSnapshot());
    }

    if (req.method === 'GET' && url.pathname === '/api/files') {
      const table = String(url.searchParams.get('table') || '').trim();
      const id = String(url.searchParams.get('id') || '').trim();
      const actor = String(url.searchParams.get('actor') || '').trim();
      const isAdmin = ['1', 'true', 'yes'].includes(String(url.searchParams.get('isAdmin') || '').trim().toLowerCase());
      if (!ATTACHMENT_TABLES.has(table) || !id) {
        return sendJson(res, 400, { ok: false, error: 'Invalid attachment request.' });
      }
      const db = getDatabase();
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
      if (!row?.file_path || !fs.existsSync(row.file_path)) {
        return sendJson(res, 404, { ok: false, error: 'Attachment file not found on server.' });
      }
      if (!canDownloadAttachment(db, table, row, actor, isAdmin)) {
        return sendJson(res, 403, { ok: false, error: 'You are not allowed to download this attachment.' });
      }
      return sendJson(res, 200, {
        ok: true,
        id: row.id,
        fileName: row.file_name || path.basename(row.file_path),
        fileBase64: fs.readFileSync(row.file_path).toString('base64'),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await readJson(req);
      const mutations = Array.isArray(body.mutations) ? body.mutations : [];
      const actor = String(body.actor || '').trim();
      const db = getDatabase();
      const results = db.transaction(() => mutations.map(mutation => applyMutation(db, mutation, actor)))();
      checkpointServerDb(db);
      scheduleDriveSnapshotUpload('api-sync');
      return sendJson(res, 200, { ok: true, serverTime: new Date().toISOString(), results, snapshot: getSnapshot() });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: String(error?.message || error) });
  }
  });
}

function startDiscoveryServer() {
  if (discoveryServer) return;
  discoveryServer = dgram.createSocket('udp4');
  discoveryServer.on('message', (message, rinfo) => {
    if (String(message || '').trim() !== DISCOVERY_MESSAGE) return;
    const lanAddresses = getLanAddresses();
    const preferredIp = lanAddresses[0] || rinfo.address || '127.0.0.1';
    const payload = Buffer.from(JSON.stringify({
      ok: true,
      role: 'erp-server',
      app: 'ERP Tasks',
      name: os.hostname(),
      port: currentPort,
      ip: preferredIp,
      url: `http://${preferredIp}:${currentPort}`,
      token: SERVER_TOKEN,
      addresses: lanAddresses,
      serverTime: new Date().toISOString(),
    }));
    discoveryServer.send(payload, rinfo.port, rinfo.address);
  });
  discoveryServer.on('error', (error) => {
    addLog('warn', `ERP LAN discovery unavailable: ${error?.message || error}`);
  });
  discoveryServer.bind(currentPort, HOST, () => {
    try {
      discoveryServer.setBroadcast(true);
    } catch {}
    addLog('info', `ERP LAN discovery listening on udp://${HOST}:${currentPort}`);
  });
}

function stopDiscoveryServer() {
  if (!discoveryServer) return Promise.resolve();
  return new Promise((resolve) => {
    const socket = discoveryServer;
    discoveryServer = null;
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function startServer(options = {}) {
  if (serverState.running) return Promise.resolve(getServerStatus());
  const requestedPort = normalizePort(options.port, currentPort || BASE_PORT);
  currentPort = requestedPort;
  serverState = makeServerState();
  const portCheck = await isServerPortAvailableOnLan(currentPort);
  if (!portCheck.available) {
    const suggestedPort = await findAvailableServerPort(currentPort + 1);
    const conflictTarget = portCheck.local
      ? `this computer on port ${currentPort}`
      : `${portCheck.server?.url || `another ERP server on port ${currentPort}`}`;
    serverState = makeServerState({
      error: `Server port already exists on ${conflictTarget}. Create new?`,
      portConflict: true,
      existingServer: portCheck.server,
      suggestedPort,
    });
    addLog('error', serverState.error);
    return getServerStatus();
  }
  return new Promise((resolve) => {
    server = createHttpServer();
    server.on('error', async (error) => {
      const isPortInUse = error?.code === 'EADDRINUSE';
      const suggestedPort = isPortInUse ? await findAvailableServerPort(currentPort + 1) : 0;
      serverState = makeServerState({
        error: isPortInUse
          ? `Server port already exists on this computer on port ${currentPort}. Create new?`
          : String(error?.message || error),
        portConflict: isPortInUse,
        suggestedPort,
      });
      server = null;
      addLog('error', `ERP server failed to start: ${serverState.error}`);
      resolve(getServerStatus());
    });
    server.listen(currentPort, HOST, () => {
      serverState = makeServerState({ running: true, startedAt: new Date().toISOString() });
      addLog('info', `ERP server listening on http://${HOST}:${currentPort}`);
      addLog('info', `LAN URLs: ${getLanAddresses().map(ip => `http://${ip}:${currentPort}`).join(', ') || `http://localhost:${currentPort}`}`);
      addLog('info', `Database folder: ${DB_DIR}`);
      addLog('info', `Client token file: ${TOKEN_FILE}`);
      addLog('info', `Direct access token file: ${DIRECT_ACCESS_TOKEN_FILE}`);
      addLog('info', `Direct DB queue poll interval: ${getDirectQueuePollSeconds()}s`);
      if (isDriveSyncConfigured()) {
        addLog('info', `Drive Web sync enabled: ${getDriveSyncConfig().driveScriptUrl}`);
        syncDriveSnapshotOnServerStart()
          .catch(error => addLog('warn', `Initial Drive DB fetch/upload failed: ${error?.message || error}`))
          .finally(() => {
            pollDirectQueueOnce();
            scheduleDirectQueuePolling();
            pollDriveQueueOnce().catch(error => addLog('warn', `Initial Drive queue poll failed: ${error?.message || error}`));
            scheduleDriveQueuePolling();
          });
      } else {
        pollDirectQueueOnce();
        scheduleDirectQueuePolling();
      }
      startDiscoveryServer();
      resolve(getServerStatus());
    });
  });
}

async function stopServer() {
  await stopDiscoveryServer();
  if (directQueueTimer) {
    clearTimeout(directQueueTimer);
    directQueueTimer = null;
  }
  if (driveQueueTimer) {
    clearTimeout(driveQueueTimer);
    driveQueueTimer = null;
  }
  if (driveSnapshotTimer) {
    clearTimeout(driveSnapshotTimer);
    driveSnapshotTimer = null;
  }
  if (!server) {
    serverState = makeServerState();
    return getServerStatus();
  }
  await new Promise((resolve) => {
    const httpServer = server;
    server = null;
    try {
      httpServer.close(() => resolve());
    } catch {
      resolve();
    }
  });
  serverState = makeServerState();
  addLog('info', 'ERP server stopped.');
  return getServerStatus();
}

function getServerStatus() {
  const lanAddresses = getLanAddresses();
  return {
    ...serverState,
    host: HOST,
    port: currentPort,
    dbDir: DB_DIR,
    tokenFile: TOKEN_FILE,
    token: SERVER_TOKEN,
    directAccessTokenFile: DIRECT_ACCESS_TOKEN_FILE,
    directAccessToken: DIRECT_ACCESS_TOKEN,
    directClientQueueDir: DIRECT_CLIENTS_DIR,
    directQueueConfigFile: DIRECT_QUEUE_CONFIG_FILE,
    directQueuePollSeconds: getDirectQueuePollSeconds(),
    driveScriptUrl: getDriveSyncConfig().driveScriptUrl,
    driveToken: getDriveSyncConfig().driveToken,
    driveTokenConfigured: !!getDriveSyncConfig().driveToken,
    lanAddresses,
    lanUrls: lanAddresses.map(ip => `http://${ip}:${currentPort}`),
  };
}

function getServerLogs() {
  return [...serverLogs];
}

function onServerLog(listener) {
  serverEvents.on('log', listener);
  return () => serverEvents.off('log', listener);
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  stopServer,
  getServerStatus,
  getServerLogs,
  getRemoteAccessConfig,
  setRemoteAccessConfig: writeDirectSyncConfig,
  onServerLog,
};
