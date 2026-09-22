// ═══════════════════════════════════════════════════════════════════════════════
// database.js — SQLite Database (better-sqlite3)
// Same schema as the original PySide6 ERP app for full compatibility.
// ═══════════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
let electronApp = null;
try {
  const electron = require('electron');
  electronApp = electron?.app || null;
} catch {}

let db = null;
const DEFAULT_USER_PASSWORD = '12345';
const SYSTEM_ADMIN_NAME = 'Admin';
const SUPERADMIN_ROLE = 'Superadmin';

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password || ''), String(salt || ''), 120000, 64, 'sha512').toString('hex');
}

function getDbPath(baseDir) {
  const userDataPath = electronApp?.getPath ? electronApp.getPath('userData') : process.cwd();
  const dbDir = baseDir || userDataPath;
  fs.mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, 'erp_tasks.db');
}

function ensureSystemAdmin(targetDb = db) {
  if (!targetDb) return;
  const row = targetDb.prepare('SELECT name FROM employees WHERE lower(name)=lower(?) LIMIT 1').get(SYSTEM_ADMIN_NAME);
  if (!row) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(DEFAULT_USER_PASSWORD, salt);
    targetDb.prepare('INSERT INTO employees(name, role, team_name, password_hash, password_salt) VALUES(?, ?, ?, ?, ?)')
      .run(SYSTEM_ADMIN_NAME, SUPERADMIN_ROLE, '', hash, salt);
    return;
  }
  targetDb.prepare('UPDATE employees SET name=?, role=?, team_name=\'\' WHERE lower(name)=lower(?)').run(SYSTEM_ADMIN_NAME, SUPERADMIN_ROLE, SYSTEM_ADMIN_NAME);
}

function initDatabase(baseDir) {
  const Database = require('better-sqlite3');
  const dbPath = getDbPath(baseDir);
  console.log('Database path:', dbPath);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');    // Better concurrent performance
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // ── Create tables ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      name TEXT PRIMARY KEY,
      role TEXT,
      team_name TEXT,
      password_hash TEXT,
      password_salt TEXT
    );

    CREATE TABLE IF NOT EXISTS teams (
      team_name TEXT PRIMARY KEY,
      lead_name TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      task_name TEXT,
      description TEXT,
      assigned_to TEXT,
      assigned_by TEXT,
      date_assigned TEXT,
      duration_val TEXT,
      duration_unit TEXT,
      due_date TEXT,
      status TEXT,
      remarks TEXT,
      template_id INTEGER,
      input_label TEXT,
      input_type TEXT,
      input_value TEXT,
      validation_rules TEXT,
      project_id TEXT,
      completed_on TEXT,
      archived_on TEXT,
      pending_target_status TEXT,
      pending_due_date TEXT,
      review_rejected_unseen INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sops (
      sop_id TEXT PRIMARY KEY,
      sop_task TEXT,
      description TEXT,
      detail_text TEXT,
      attachment_path TEXT,
      assigned_to TEXT,
      assigned_by TEXT,
      created_on TEXT,
      updated_on TEXT
    );

    CREATE TABLE IF NOT EXISTS task_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      changed_on TEXT,
      changed_by TEXT,
      action TEXT,
      summary TEXT,
      details_json TEXT
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      author TEXT,
      message TEXT,
      created_on TEXT
    );

    CREATE TABLE IF NOT EXISTS task_comment_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER,
      file_name TEXT,
      file_path TEXT,
      added_on TEXT
    );

    CREATE TABLE IF NOT EXISTS task_comment_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER,
      user_name TEXT,
      read_on TEXT
    );

    CREATE TABLE IF NOT EXISTS subtask_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subtask_id TEXT,
      author TEXT,
      message TEXT,
      created_on TEXT
    );

    CREATE TABLE IF NOT EXISTS subtask_comment_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER,
      file_name TEXT,
      file_path TEXT,
      added_on TEXT
    );

    CREATE TABLE IF NOT EXISTS subtask_comment_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER,
      user_name TEXT,
      read_on TEXT
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      subtask_id TEXT PRIMARY KEY,
      task_id TEXT,
      subtask_name TEXT,
      status TEXT,
      assigned_to TEXT,
      assigned_by TEXT,
      description TEXT,
      date_assigned TEXT,
      duration_val TEXT,
      duration_unit TEXT,
      due_date TEXT,
      remarks TEXT,
      input_label TEXT,
      input_type TEXT,
      input_value TEXT,
      validation_rules TEXT
    );

    CREATE TABLE IF NOT EXISTS task_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT,
      is_subtask INTEGER,
      file_name TEXT,
      file_path TEXT,
      added_on TEXT,
      added_by TEXT
    );

    CREATE TABLE IF NOT EXISTS task_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT,
      is_subtask INTEGER,
      remind_minutes TEXT,
      due_date TEXT,
      remind_at TEXT,
      created_on TEXT
    );

    CREATE TABLE IF NOT EXISTS recurring_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_name TEXT,
      description TEXT,
      assigned_to TEXT,
      assigned_by TEXT,
      duration_val TEXT,
      duration_unit TEXT,
      frequency TEXT,
      next_run_date TEXT,
      custom_interval TEXT,
      custom_unit TEXT,
      project_id TEXT,
      reminder_minutes TEXT,
      attachment_paths TEXT
    );

    CREATE TABLE IF NOT EXISTS task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_name TEXT,
      description TEXT,
      duration_val TEXT,
      duration_unit TEXT,
      default_assigned_to TEXT,
      default_status TEXT,
      created_by TEXT,
      date_created TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      project_name TEXT,
      description TEXT,
      team_name TEXT,
      owner_name TEXT,
      status TEXT,
      priority TEXT,
      start_date TEXT,
      due_date TEXT,
      progress TEXT,
      created_by TEXT,
      created_on TEXT,
      updated_on TEXT
    );

    CREATE TABLE IF NOT EXISTS issues (
      issue_id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      task_id TEXT,
      reported_by TEXT,
      assigned_to TEXT,
      priority TEXT,
      status TEXT,
      date_reported TEXT,
      remarks TEXT
    );

    CREATE TABLE IF NOT EXISTS issue_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT,
      author TEXT,
      message TEXT,
      created_on TEXT
    );

    CREATE TABLE IF NOT EXISTS issue_comment_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER,
      file_name TEXT,
      file_path TEXT,
      added_on TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_updates (
      update_id TEXT PRIMARY KEY,
      employee_name TEXT,
      log_date TEXT,
      work_done TEXT,
      submitted_at TEXT,
      updated_at TEXT,
      admin_reply TEXT,
      admin_reply_by TEXT,
      admin_reply_at TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_name TEXT,
      key TEXT,
      value TEXT,
      PRIMARY KEY (user_name, key)
    );

    CREATE TABLE IF NOT EXISTS sync_deletions (
      id TEXT PRIMARY KEY,
      table_name TEXT,
      pk TEXT,
      pk_value TEXT,
      deleted_at TEXT,
      deleted_by TEXT
    );
  `);

  // ── Seed default data if empty ─────────────────────────────────────────────
  const empCount = db.prepare('SELECT COUNT(*) AS cnt FROM employees').get().cnt;
  if (empCount === 0) {
    const insertEmp = db.prepare('INSERT INTO employees(name, role, team_name, password_hash, password_salt) VALUES(?, ?, ?, ?, ?)');
    const insertTeam = db.prepare("INSERT OR IGNORE INTO teams(team_name, lead_name) VALUES(?, '')");

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(DEFAULT_USER_PASSWORD, salt);
    insertEmp.run(SYSTEM_ADMIN_NAME, SUPERADMIN_ROLE, '', hash, salt);
  }

  // Normalize null team assignments to empty when teams are not used.
  db.prepare("UPDATE employees SET team_name='' WHERE team_name IS NULL").run();
  // Backward-compatible migration for older databases.
  const employeeCols = db.prepare("PRAGMA table_info(employees)").all();
  const hasPasswordHash = employeeCols.some(c => c.name === 'password_hash');
  const hasPasswordSalt = employeeCols.some(c => c.name === 'password_salt');
  if (!hasPasswordHash) {
    db.prepare('ALTER TABLE employees ADD COLUMN password_hash TEXT').run();
  }
  if (!hasPasswordSalt) {
    db.prepare('ALTER TABLE employees ADD COLUMN password_salt TEXT').run();
  }

  const missingPasswordRows = db.prepare(`
    SELECT name FROM employees
    WHERE trim(COALESCE(password_hash, '')) = '' OR trim(COALESCE(password_salt, '')) = ''
  `).all();
  if (missingPasswordRows.length) {
    const fillPasswordTx = db.transaction((rows) => {
      const stmt = db.prepare('UPDATE employees SET password_hash=?, password_salt=? WHERE name=?');
      for (const row of rows) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = hashPassword(DEFAULT_USER_PASSWORD, salt);
        stmt.run(hash, salt, row.name);
      }
    });
    fillPasswordTx(missingPasswordRows);
  }

  const recurringCols = db.prepare("PRAGMA table_info(recurring_tasks)").all();
  const hasAttachmentPaths = recurringCols.some(c => c.name === 'attachment_paths');
  if (!hasAttachmentPaths) {
    db.prepare('ALTER TABLE recurring_tasks ADD COLUMN attachment_paths TEXT').run();
  }

  const attachmentCols = db.prepare("PRAGMA table_info(task_attachments)").all();
  const hasAttachmentAddedBy = attachmentCols.some(c => c.name === 'added_by');
  if (!hasAttachmentAddedBy) {
    db.prepare('ALTER TABLE task_attachments ADD COLUMN added_by TEXT').run();
  }

  const taskCols = db.prepare("PRAGMA table_info(tasks)").all();
  const hasCompletedOn = taskCols.some(c => c.name === 'completed_on');
  const hasArchivedOn = taskCols.some(c => c.name === 'archived_on');
  const hasPendingTargetStatus = taskCols.some(c => c.name === 'pending_target_status');
  const hasPendingDueDate = taskCols.some(c => c.name === 'pending_due_date');
  const hasReviewRejectedUnseen = taskCols.some(c => c.name === 'review_rejected_unseen');
  const hasTaskInputLabel = taskCols.some(c => c.name === 'input_label');
  const hasTaskInputType = taskCols.some(c => c.name === 'input_type');
  const hasTaskInputValue = taskCols.some(c => c.name === 'input_value');
  const hasTaskValidationRules = taskCols.some(c => c.name === 'validation_rules');
  if (!hasCompletedOn) {
    db.prepare('ALTER TABLE tasks ADD COLUMN completed_on TEXT').run();
  }
  if (!hasArchivedOn) {
    db.prepare('ALTER TABLE tasks ADD COLUMN archived_on TEXT').run();
  }
  if (!hasPendingTargetStatus) {
    db.prepare('ALTER TABLE tasks ADD COLUMN pending_target_status TEXT').run();
  }
  if (!hasPendingDueDate) {
    db.prepare('ALTER TABLE tasks ADD COLUMN pending_due_date TEXT').run();
  }
  if (!hasReviewRejectedUnseen) {
    db.prepare('ALTER TABLE tasks ADD COLUMN review_rejected_unseen INTEGER DEFAULT 0').run();
  }
  if (!hasTaskInputLabel) {
    db.prepare('ALTER TABLE tasks ADD COLUMN input_label TEXT').run();
  }
  if (!hasTaskInputType) {
    db.prepare('ALTER TABLE tasks ADD COLUMN input_type TEXT').run();
  }
  if (!hasTaskInputValue) {
    db.prepare('ALTER TABLE tasks ADD COLUMN input_value TEXT').run();
  }
  if (!hasTaskValidationRules) {
    db.prepare('ALTER TABLE tasks ADD COLUMN validation_rules TEXT').run();
  }
  ensureSystemAdmin(db);

  console.log('Database initialized successfully');
  return db;
}

function getDatabase() {
  return db;
}

function closeDatabase() {
  if (!db) return;
  try {
    db.close();
  } catch {}
  db = null;
}

module.exports = { initDatabase, getDatabase, closeDatabase, ensureSystemAdmin, SYSTEM_ADMIN_NAME, SUPERADMIN_ROLE };
