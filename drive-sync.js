const fs = require('fs');
const path = require('path');
const { initDatabase, getDatabase, ensureSystemAdmin } = require('./database');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SNAPSHOT_FILE = 'erp-snapshot.json';
const QUEUE_ROOT = 'remote-queues';
const QUEUE_FILE_PREFIX = 'queue-';
const QUEUE_FILE_EXT = '.json';
const CACHE_DIR = process.env.ERP_CLIENT_CACHE_DIR || path.join(process.cwd(), 'client-cache');
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
];
const ATTACHMENT_TABLES = new Set([
  'task_attachments',
  'task_comment_attachments',
  'subtask_comment_attachments',
  'issue_comment_attachments',
]);

let tokenCache = { key: '', accessToken: '', expiresAt: 0 };

function sanitizeFileName(value) {
  return String(value || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180) || 'file';
}

function normalizeDriveConfig(config = {}) {
  return {
    folderId: String(config.folderId || config.driveFolderId || process.env.ERP_DRIVE_FOLDER_ID || '').trim(),
    clientId: String(config.clientId || config.driveClientId || process.env.ERP_DRIVE_CLIENT_ID || '').trim(),
    clientSecret: String(config.clientSecret || config.driveClientSecret || process.env.ERP_DRIVE_CLIENT_SECRET || '').trim(),
    refreshToken: String(config.refreshToken || config.driveRefreshToken || process.env.ERP_DRIVE_REFRESH_TOKEN || '').trim(),
  };
}

function validateDriveConfig(config = {}) {
  const cfg = normalizeDriveConfig(config);
  const missing = [];
  if (!cfg.folderId) missing.push('Drive folder ID');
  if (!cfg.clientId) missing.push('Google client ID');
  if (!cfg.clientSecret) missing.push('Google client secret');
  if (!cfg.refreshToken) missing.push('Google refresh token');
  if (missing.length) throw new Error(`${missing.join(', ')} required.`);
  return cfg;
}

async function getAccessToken(config = {}) {
  const cfg = validateDriveConfig(config);
  const key = [cfg.clientId, cfg.refreshToken].join('|');
  if (tokenCache.key === key && tokenCache.accessToken && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.accessToken;
  }
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google token refresh failed: ${response.status}`);
  }
  tokenCache = {
    key,
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };
  return tokenCache.accessToken;
}

async function driveRequest(config, url, options = {}) {
  const token = await getAccessToken(config);
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (options.raw) {
    if (!response.ok) throw new Error(`Google Drive request failed: ${response.status}`);
    return response;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.error_description || `Google Drive request failed: ${response.status}`);
  }
  return data;
}

function driveQueryEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findChild(config, parentId, name, mimeType = '') {
  const clauses = [
    `'${driveQueryEscape(parentId)}' in parents`,
    `name='${driveQueryEscape(name)}'`,
    'trashed=false',
  ];
  if (mimeType) clauses.push(`mimeType='${driveQueryEscape(mimeType)}'`);
  const params = new URLSearchParams({
    q: clauses.join(' and '),
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    pageSize: '1',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const data = await driveRequest(config, `${DRIVE_API}/files?${params.toString()}`);
  return Array.isArray(data.files) && data.files.length ? data.files[0] : null;
}

async function ensureFolder(config, parentId, name) {
  const existing = await findChild(config, parentId, name, 'application/vnd.google-apps.folder');
  if (existing?.id) return existing.id;
  const data = await driveRequest(config, `${DRIVE_API}/files?supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  return data.id;
}

async function uploadJson(config, parentId, name, payload) {
  const existing = await findChild(config, parentId, name, 'application/json');
  const metadata = { name, mimeType: 'application/json' };
  if (!existing?.id) metadata.parents = [parentId];
  const boundary = `erp_drive_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(payload),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const url = existing?.id
    ? `${DRIVE_UPLOAD_API}/files/${existing.id}?uploadType=multipart&supportsAllDrives=true`
    : `${DRIVE_UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true`;
  return driveRequest(config, url, {
    method: existing?.id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function downloadJsonByName(config, parentId, name) {
  const file = await findChild(config, parentId, name, 'application/json');
  if (!file?.id) throw new Error(`${name} not found in Drive folder.`);
  const response = await driveRequest(config, `${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`, { raw: true });
  return response.json();
}

async function listJsonFiles(config, parentId) {
  const params = new URLSearchParams({
    q: `'${driveQueryEscape(parentId)}' in parents and mimeType='application/json' and trashed=false`,
    fields: 'files(id,name,modifiedTime,size)',
    pageSize: '1000',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const data = await driveRequest(config, `${DRIVE_API}/files?${params.toString()}`);
  return Array.isArray(data.files) ? data.files : [];
}

async function deleteFile(config, fileId) {
  if (!fileId) return;
  await driveRequest(config, `${DRIVE_API}/files/${fileId}?supportsAllDrives=true`, { method: 'DELETE' });
}

function getSnapshotFromDb(db, meta = {}) {
  const tables = {};
  for (const table of SYNC_TABLES) {
    try {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      tables[table] = ATTACHMENT_TABLES.has(table)
        ? rows.map(row => {
            const filePath = String(row?.file_path || '');
            if (!filePath || !fs.existsSync(filePath)) return row;
            try {
              return { ...row, fileBase64: fs.readFileSync(filePath).toString('base64') };
            } catch {
              return row;
            }
          })
        : rows;
    } catch {
      tables[table] = [];
    }
  }
  return {
    ok: true,
    role: 'erp-drive-snapshot',
    version: 1,
    serverTime: new Date().toISOString(),
    meta,
    tables,
  };
}

function getLocalAttachmentDir(cacheDir) {
  const dir = path.join(cacheDir || CACHE_DIR, 'DB', 'attachments', 'server-sync');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function localizeAttachmentRows(rows, cacheDir, table) {
  if (!ATTACHMENT_TABLES.has(table) || !Array.isArray(rows) || !rows.length) return rows;
  const dir = getLocalAttachmentDir(cacheDir);
  return rows.map(row => {
    if (!row?.fileBase64) return row;
    try {
      const fileName = sanitizeFileName(row.file_name || `attachment-${row.id || Date.now()}`);
      const localPath = path.join(dir, `${table}-${sanitizeFileName(row.id || Date.now())}-${fileName}`);
      fs.writeFileSync(localPath, Buffer.from(String(row.fileBase64), 'base64'));
      const next = { ...row, file_path: localPath };
      delete next.fileBase64;
      return next;
    } catch {
      return row;
    }
  });
}

function replaceLocalTable(db, table, rows, cacheDir) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(col => col.name);
  if (!columns.length) return;
  const localRows = localizeAttachmentRows(rows, cacheDir, table);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ${table}`).run();
    if (!localRows?.length) return;
    const insertColumns = columns.filter(col => Object.prototype.hasOwnProperty.call(localRows[0], col));
    if (!insertColumns.length) return;
    const placeholders = insertColumns.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${insertColumns.join(', ')}) VALUES (${placeholders})`);
    for (const row of localRows) stmt.run(...insertColumns.map(col => row[col]));
  });
  tx();
}

function withAttachmentPayloads(mutations) {
  return (mutations || []).map(mutation => {
    if (!ATTACHMENT_TABLES.has(mutation?.table) || mutation.action === 'delete') return mutation;
    const filePath = mutation?.data?.file_path;
    if (!filePath || !fs.existsSync(filePath)) return mutation;
    return {
      ...mutation,
      fileName: mutation.data.file_name || path.basename(filePath),
      fileBase64: fs.readFileSync(filePath).toString('base64'),
    };
  });
}

async function publishDriveSnapshot({ drive, db, meta }) {
  const cfg = validateDriveConfig(drive);
  const snapshot = getSnapshotFromDb(db || getDatabase(), meta);
  const uploaded = await uploadJson(cfg, cfg.folderId, SNAPSHOT_FILE, snapshot);
  return { ok: true, fileId: uploaded.id, serverTime: snapshot.serverTime };
}

async function pullDriveSnapshotToLocalCache({ drive, cacheDir }) {
  const cfg = validateDriveConfig(drive);
  const snapshot = await downloadJsonByName(cfg, cfg.folderId, SNAPSHOT_FILE);
  const db = getDatabase() || initDatabase(cacheDir || CACHE_DIR);
  for (const [table, rows] of Object.entries(snapshot.tables || {})) {
    replaceLocalTable(db, table, Array.isArray(rows) ? rows : [], cacheDir);
  }
  ensureSystemAdmin(db);
  return { ok: true, drive: true, serverTime: snapshot.serverTime || new Date().toISOString() };
}

async function getClientQueueFolder(config, clientId) {
  const cfg = validateDriveConfig(config);
  const queueRootId = await ensureFolder(cfg, cfg.folderId, QUEUE_ROOT);
  const clientFolderName = sanitizeFileName(clientId || 'remote-client');
  const clientFolderId = await ensureFolder(cfg, queueRootId, clientFolderName);
  return { cfg, queueRootId, clientFolderId };
}

async function queueDriveMutations({ drive, actor, clientId, mutations }) {
  const { cfg, clientFolderId } = await getClientQueueFolder(drive, clientId);
  const cleanMutations = withAttachmentPayloads(mutations || []).filter(Boolean);
  if (!cleanMutations.length) return { ok: true, skipped: true, drive: true, pendingCount: 0 };
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    clientId: String(clientId || ''),
    actor: String(actor || 'system'),
    mutations: cleanMutations,
    queuedAt: new Date().toISOString(),
  };
  await uploadJson(cfg, clientFolderId, `${QUEUE_FILE_PREFIX}${item.id}${QUEUE_FILE_EXT}`, item);
  const status = await getDriveQueueStatus({ drive, clientId });
  return { ok: true, queued: true, drive: true, pendingCount: status.pendingCount, queueFolderId: clientFolderId };
}

async function getDriveQueueStatus({ drive, clientId }) {
  try {
    const { cfg, clientFolderId } = await getClientQueueFolder(drive, clientId);
    const files = await listJsonFiles(cfg, clientFolderId);
    const queueFiles = files.filter(file => String(file.name || '').startsWith(QUEUE_FILE_PREFIX));
    return { ok: true, drive: true, pendingCount: queueFiles.length, queueFolderId: clientFolderId };
  } catch (error) {
    return { ok: false, drive: true, pendingCount: 0, error: String(error?.message || error) };
  }
}

async function processDriveQueues({ drive, applyItem }) {
  const cfg = validateDriveConfig(drive);
  const queueRoot = await findChild(cfg, cfg.folderId, QUEUE_ROOT, 'application/vnd.google-apps.folder');
  if (!queueRoot?.id) return { ok: true, processed: 0, retried: 0 };
  const params = new URLSearchParams({
    q: `'${driveQueryEscape(queueRoot.id)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: '1000',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const folderRows = await driveRequest(cfg, `${DRIVE_API}/files?${params.toString()}`);
  let processed = 0;
  let retried = 0;
  const errors = [];
  for (const folder of (folderRows.files || [])) {
    const files = await listJsonFiles(cfg, folder.id);
    for (const file of files.filter(row => String(row.name || '').startsWith(QUEUE_FILE_PREFIX))) {
      try {
        const response = await driveRequest(cfg, `${DRIVE_API}/files/${file.id}?alt=media&supportsAllDrives=true`, { raw: true });
        const item = await response.json();
        await applyItem(item);
        await deleteFile(cfg, file.id);
        processed += 1;
      } catch (error) {
        retried += 1;
        errors.push(`${file.name}: ${error?.message || error}`);
      }
    }
  }
  return { ok: errors.length === 0, processed, retried, error: errors.join('; ') };
}

module.exports = {
  SNAPSHOT_FILE,
  QUEUE_ROOT,
  SYNC_TABLES,
  validateDriveConfig,
  publishDriveSnapshot,
  pullDriveSnapshotToLocalCache,
  queueDriveMutations,
  getDriveQueueStatus,
  processDriveQueues,
};
