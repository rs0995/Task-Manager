const FOLDER_ID = '1G_k0_OVBrLYbO-QvywhTJ-5I1TiIw5vz';
const TOKEN = 'asdf1234';
const DATA_FOLDER_NAME = 'server-data';
const DB_FILE = 'erp_tasks.db';
const DB_BASE64_FILE = DB_FILE + '.base64';
const CONNECTION_TEST_FILE = 'erp-drive-connection-test.json';
const CLIENTS_DIR = 'direct-sync-clients';
const PROCESSED_DIR = 'processed-queues';
const ATTACHMENTS_DIR = 'attachments'; // NEW — individual attachment files, stored as base64 text, same convention as DB_BASE64_FILE.

function doGet(e) {
  try {
    checkToken(e.parameter.token);
    const action = e.parameter.action || 'health';

    if (action === 'health') {
      const dataFolder = getDataFolder();
      const base64File = findFile(dataFolder, DB_BASE64_FILE);
      const dbFile = findFile(dataFolder, DB_FILE);
      const file = base64File || dbFile;
      return json({
        ok: true,
        serverTime: new Date().toISOString(),
        folderId: dataFolder.getId(),
        folderName: dataFolder.getName(),
        dbFound: !!file,
        dbFileName: file ? file.getName() : '',
        snapshotMode: base64File ? 'base64-text' : (dbFile ? 'binary-db' : ''),
        dbUpdatedAt: file ? file.getLastUpdated().toISOString() : '',
      });
    }

    if (action === 'diagnose') {
      const root = getRootFolder();
      const dataFolder = getDataFolder();
      return json({
        ok: true,
        rootFolderId: root.getId(),
        rootFolderName: root.getName(),
        dataFolderId: dataFolder.getId(),
        dataFolderName: dataFolder.getName(),
        files: listFolderFiles(dataFolder),
      });
    }

    if (action === 'connectionTest') {
      const challenge = String(e.parameter.challenge || '').trim();
      const appCode = String(e.parameter.appCode || '').trim();
      if (!challenge || !appCode) return json({ ok: false, error: 'Missing connection test challenge' });
      const dataFolder = getDataFolder();
      const data = {
        appCode: appCode,
        challenge: challenge,
        checkedAt: new Date().toISOString(),
      };
      let file;
      try {
        file = upsertTextFile(dataFolder, CONNECTION_TEST_FILE, JSON.stringify(data));
      } catch (err) {
        return json({ ok: false, error: 'Drive connection test write failed: ' + String(err.message || err) });
      }
      let readBack;
      try {
        readBack = JSON.parse(file.getBlob().getDataAsString() || '{}');
      } catch (err) {
        return json({ ok: false, error: 'Drive connection test read failed: ' + String(err.message || err) });
      }
      const base64File = findFile(dataFolder, DB_BASE64_FILE);
      const dbFile = findFile(dataFolder, DB_FILE);
      const snapshotFile = base64File || dbFile;
      return json({
        ok: readBack.appCode === appCode && readBack.challenge === challenge,
        appCode: readBack.appCode || '',
        challenge: readBack.challenge || '',
        serverTime: new Date().toISOString(),
        folderId: dataFolder.getId(),
        folderName: dataFolder.getName(),
        dbFound: !!snapshotFile,
        dbFileName: snapshotFile ? snapshotFile.getName() : '',
        snapshotMode: base64File ? 'base64-text' : (dbFile ? 'binary-db' : ''),
        dbUpdatedAt: snapshotFile ? snapshotFile.getLastUpdated().toISOString() : '',
      });
    }

    if (action === 'snapshot') {
      const dataFolder = getDataFolder();
      const base64File = findFile(dataFolder, DB_BASE64_FILE);
      const file = base64File || findFile(dataFolder, DB_FILE);
      if (!file) return json({ ok: false, error: 'DB snapshot file not found in ' + dataFolder.getName() });
      const base64 = base64File
        ? base64File.getBlob().getDataAsString().trim()
        : Utilities.base64Encode(file.getBlob().getBytes());
      return json({
        ok: true,
        fileName: DB_FILE,
        sourceFileName: file.getName(),
        folderId: dataFolder.getId(),
        folderName: dataFolder.getName(),
        updatedAt: file.getLastUpdated().toISOString(),
        snapshotMode: base64File ? 'base64-text' : 'binary-db',
        base64: base64,
      });
    }

    // NEW — was never implemented, even though the Remote client app has
    // always called this action expecting it to exist. Looks up a single
    // attachment file by the same deterministic name the server uses when
    // uploading it (see uploadAttachment in doPost, and attachmentFileName
    // below) and returns its content as base64 text.
    if (action === 'attachment') {
      const table = cleanName(e.parameter.table || '');
      const id = cleanName(e.parameter.id || '');
      const fileName = String(e.parameter.fileName || e.parameter.sourceName || '');
      if (!table || !id) return json({ ok: false, error: 'Missing table/id for attachment lookup.' });
      const attachmentsFolder = findFolder(getDataFolder(), ATTACHMENTS_DIR);
      if (!attachmentsFolder) return json({ ok: false, error: 'No attachments have been uploaded yet.' });
      const file = findAttachmentFile(attachmentsFolder, table, id);
      if (!file) return json({ ok: false, error: 'Attachment not found on Drive.' });
      const base64 = file.getBlob().getDataAsString().trim();
      return json({
        ok: true,
        fileName: fileName || attachmentDisplayName(file.getName()),
        updatedAt: file.getLastUpdated().toISOString(),
        base64: base64,
      });
    }

    if (action === 'listQueues') {
      return json({ ok: true, files: listQueueFiles() });
    }

    if (action === 'queue') {
      const file = DriveApp.getFileById(String(e.parameter.fileId || ''));
      return json({
        ok: true,
        fileId: file.getId(),
        fileName: file.getName(),
        text: file.getBlob().getDataAsString(),
      });
    }

    if (action === 'queueStatus') {
      const clientId = cleanName(e.parameter.clientId || '');
      const files = listQueueFiles().filter(function (file) {
        return !clientId || String(file.clientId || '') === clientId;
      });
      return json({ ok: true, pendingCount: files.length });
    }

    return json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    checkToken(body.token);

    if (body.action === 'uploadSnapshot') {
      const base64 = String(body.base64 || '').trim();
      if (!base64) return json({ ok: false, error: 'Missing DB snapshot content' });
      let file;
      try {
        file = upsertTextFile(getDataFolder(), DB_BASE64_FILE, base64);
      } catch (err) {
        return json({
          ok: false,
          error: 'DB snapshot write failed for ' + DB_BASE64_FILE + ': ' + String(err.message || err),
        });
      }
      return json({
        ok: true,
        updatedAt: file.getLastUpdated().toISOString(),
        fileId: file.getId(),
        fileName: file.getName(),
        snapshotMode: 'base64-text',
      });
    }

    // NEW — counterpart to the 'attachment' GET action above. Stores an
    // individual attachment file's content (sent as base64 text, same
    // convention as the DB snapshot) under a deterministic name so it can
    // be looked up later by table+id regardless of what the file was
    // originally called.
    if (body.action === 'uploadAttachment') {
      const table = cleanName(body.table || '');
      const id = cleanName(body.id || '');
      const base64 = String(body.base64 || '').trim();
      if (!table || !id) return json({ ok: false, error: 'Missing table/id for attachment upload.' });
      if (!base64) return json({ ok: false, error: 'Missing attachment content.' });
      const originalName = cleanName(body.fileName || 'attachment');
      const attachmentsFolder = getOrCreateFolder(getDataFolder(), ATTACHMENTS_DIR);
      const storedName = attachmentFileName(table, id, originalName);
      removeExistingAttachmentVersions(attachmentsFolder, table, id);
      const file = attachmentsFolder.createFile(storedName, base64, MimeType.PLAIN_TEXT);
      return json({
        ok: true,
        fileId: file.getId(),
        fileName: storedName,
        updatedAt: file.getLastUpdated().toISOString(),
      });
    }

    if (body.action === 'queue') {
      const clientId = cleanName(body.clientId || body.actor || 'remote-client');
      const clientsFolder = getOrCreateFolder(getDataFolder(), CLIENTS_DIR);
      const clientFolder = getOrCreateFolder(clientsFolder, 'remote-' + clientId);
      const name = 'queue-' + Date.now() + '.jsonl';
      const lines = (body.items || []).map(function (item) {
        return JSON.stringify(item);
      }).join('\n') + '\n';
      const file = clientFolder.createFile(name, lines, MimeType.PLAIN_TEXT);
      return json({ ok: true, fileId: file.getId(), fileName: name, pendingCount: listQueueFiles().length });
    }

    if (body.action === 'markQueueProcessed') {
      moveToProcessed(String(body.fileId || ''));
      return json({ ok: true });
    }

    if (body.action === 'replaceQueue') {
      const file = DriveApp.getFileById(String(body.fileId || ''));
      if ((body.items || []).length) {
        const lines = body.items.map(function (item) {
          return JSON.stringify(item);
        }).join('\n') + '\n';
        file.setContent(lines);
      } else {
        moveToProcessed(file.getId());
      }
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

// NEW — deterministic stored filename for an attachment: tableId-rowId-originalName.
// Keeping the original name as a suffix (rather than discarding it) means
// listFolderFiles()/manual Drive browsing still shows something recognizable.
function attachmentFileName(table, id, originalName) {
  return table + '-' + id + '-' + (originalName || 'attachment') + '.b64';
}

// NEW — strips the table-id- prefix and .b64 suffix back off, for returning
// a sensible fileName to the client when one wasn't already known.
function attachmentDisplayName(storedName) {
  return String(storedName || '').replace(/^.*?-.*?-/, '').replace(/\.b64$/i, '') || 'attachment';
}

// NEW — finds the current stored file for a given table+id, regardless of
// what the original filename suffix is (it can change if the attachment
// was replaced with a different file later).
function findAttachmentFile(folder, table, id) {
  const prefix = table + '-' + id + '-';
  const files = folder.getFiles();
  let latest = null;
  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().indexOf(prefix) !== 0) continue;
    if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) {
      latest = file;
    }
  }
  return latest;
}

// NEW — before saving a fresh upload, remove any older stored version(s)
// for the same table+id (e.g. from a previous filename, if the attachment
// was replaced) so lookups never accidentally return stale content.
function removeExistingAttachmentVersions(folder, table, id) {
  const prefix = table + '-' + id + '-';
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().indexOf(prefix) === 0) {
      file.setTrashed(true);
    }
  }
}

function listQueueFiles() {
  const clientsFolder = findFolder(getDataFolder(), CLIENTS_DIR);
  if (!clientsFolder) return [];
  const results = [];
  const clientFolders = clientsFolder.getFolders();
  while (clientFolders.hasNext()) {
    const clientFolder = clientFolders.next();
    const files = clientFolder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (/^queue-.*\.jsonl$/i.test(file.getName())) {
        results.push({
          fileId: file.getId(),
          fileName: file.getName(),
          clientId: clientFolder.getName().replace(/^remote-/, ''),
          updatedAt: file.getLastUpdated().toISOString(),
        });
      }
    }
  }
  return results;
}

function moveToProcessed(fileId) {
  if (!fileId) return;
  const file = DriveApp.getFileById(fileId);
  const processedFolder = getOrCreateFolder(getDataFolder(), PROCESSED_DIR);
  file.moveTo(processedFolder);
}

function upsertTextFile(folder, name, content) {
  const existing = findFile(folder, name);
  if (existing) {
    try {
      existing.setContent(content);
      return existing;
    } catch (err) {
    }
  }
  return folder.createFile(name, content, MimeType.PLAIN_TEXT);
}

function checkToken(token) {
  if (String(token || '') !== TOKEN) throw new Error('Unauthorized');
}

function getRootFolder() {
  return DriveApp.getFolderById(FOLDER_ID);
}

function getDataFolder() {
  const root = getRootFolder();
  if (root.getName() === DATA_FOLDER_NAME || findFile(root, DB_BASE64_FILE) || findFile(root, DB_FILE)) return root;
  const nested = findFolder(root, DATA_FOLDER_NAME);
  return nested || root;
}

function listFolderFiles(folder) {
  const results = [];
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    results.push({
      name: file.getName(),
      id: file.getId(),
      size: file.getSize(),
      updatedAt: file.getLastUpdated().toISOString(),
    });
  }
  return results;
}

function findFile(folder, name) {
  const files = folder.getFilesByName(name);
  let latest = null;
  while (files.hasNext()) {
    const file = files.next();
    if (!latest || file.getLastUpdated().getTime() > latest.getLastUpdated().getTime()) {
      latest = file;
    }
  }
  return latest;
}

function findFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : null;
}

function getOrCreateFolder(parent, name) {
  return findFolder(parent, name) || parent.createFolder(name);
}

function cleanName(value) {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}