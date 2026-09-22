// ═══════════════════════════════════════════════════════════════════════════════
// preload.js — Context Bridge (Secure IPC)
// ═══════════════════════════════════════════════════════════════════════════════
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  auth: {
    login: (data) => ipcRenderer.invoke('auth:login', data),
    logout: (data) => ipcRenderer.invoke('auth:logout', data),
    changePassword: (data) => ipcRenderer.invoke('auth:changePassword', data),
    isDefaultPassword: (data) => ipcRenderer.invoke('auth:isDefaultPassword', data),
    getRememberedLogin: () => ipcRenderer.invoke('auth:remember:get'),
    setRememberedLogin: (data) => ipcRenderer.invoke('auth:remember:set', data),
    clearRememberedLogin: () => ipcRenderer.invoke('auth:remember:clear'),
  },
  // ── Database Calls ──
  employees: {
    list: () => ipcRenderer.invoke('db:employees:list'),
    add: (data) => ipcRenderer.invoke('db:employees:add', data),
    update: (data) => ipcRenderer.invoke('db:employees:update', data),
    delete: (data) => ipcRenderer.invoke('db:employees:delete', data),
  },
  teams: {
    list: () => ipcRenderer.invoke('db:teams:list'),
    add: (data) => ipcRenderer.invoke('db:teams:add', data),
    delete: (data) => ipcRenderer.invoke('db:teams:delete', data),
  },
  tasks: {
    list: (params) => ipcRenderer.invoke('db:tasks:list', params),
    create: (data) => ipcRenderer.invoke('db:tasks:create', data),
    update: (data) => ipcRenderer.invoke('db:tasks:update', data),
    delete: (data) => ipcRenderer.invoke('db:tasks:delete', data),
    setStatus: (data) => ipcRenderer.invoke('db:tasks:setStatus', data),
    validate: (data) => ipcRenderer.invoke('db:tasks:validate', data),
    clearReviewReject: (data) => ipcRenderer.invoke('db:tasks:clearReviewReject', data),
    restore: (data) => ipcRenderer.invoke('db:tasks:restore', data),
    extendNextDay: (data) => ipcRenderer.invoke('db:tasks:extendNextDay', data),
  },
  taskHistory: {
    list: (params) => ipcRenderer.invoke('db:taskHistory:list', params),
  },
  sops: {
    list: (params) => ipcRenderer.invoke('db:sops:list', params),
    create: (data) => ipcRenderer.invoke('db:sops:create', data),
    update: (data) => ipcRenderer.invoke('db:sops:update', data),
    delete: (data) => ipcRenderer.invoke('db:sops:delete', data),
  },
  subtasks: {
    list: (params) => ipcRenderer.invoke('db:subtasks:list', params),
    create: (data) => ipcRenderer.invoke('db:subtasks:create', data),
    update: (data) => ipcRenderer.invoke('db:subtasks:update', data),
    delete: (data) => ipcRenderer.invoke('db:subtasks:delete', data),
    setStatus: (data) => ipcRenderer.invoke('db:subtasks:setStatus', data),
  },
  projects: {
    list: (params) => ipcRenderer.invoke('db:projects:list', params),
    create: (data) => ipcRenderer.invoke('db:projects:create', data),
    update: (data) => ipcRenderer.invoke('db:projects:update', data),
    delete: (data) => ipcRenderer.invoke('db:projects:delete', data),
  },
  issues: {
    list: () => ipcRenderer.invoke('db:issues:list'),
    create: (data) => ipcRenderer.invoke('db:issues:create', data),
    update: (data) => ipcRenderer.invoke('db:issues:update', data),
    delete: (data) => ipcRenderer.invoke('db:issues:delete', data),
  },
  dailyUpdates: {
    list: (params) => ipcRenderer.invoke('db:dailyUpdates:list', params),
    upsert: (data) => ipcRenderer.invoke('db:dailyUpdates:upsert', data),
    reply: (data) => ipcRenderer.invoke('db:dailyUpdates:reply', data),
    delete: (data) => ipcRenderer.invoke('db:dailyUpdates:delete', data),
  },
  recurring: {
    list: () => ipcRenderer.invoke('db:recurring:list'),
    create: (data) => ipcRenderer.invoke('db:recurring:create', data),
    update: (data) => ipcRenderer.invoke('db:recurring:update', data),
    delete: (data) => ipcRenderer.invoke('db:recurring:delete', data),
    process: () => ipcRenderer.invoke('db:recurring:process'),
  },
  // ── Dialogs ──
  saveCsv: (content) => ipcRenderer.invoke('dialog:save-csv', content),
  openFile: () => ipcRenderer.invoke('dialog:open-file'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  openPath: (path) => ipcRenderer.invoke('shell:open-path', path),

  // ── Attachments ──
  attachments: {
    list: (params) => ipcRenderer.invoke('db:attachments:list', params),
    add: (data) => ipcRenderer.invoke('db:attachments:add', data),
    remove: (data) => ipcRenderer.invoke('db:attachments:remove', data),
    replace: (data) => ipcRenderer.invoke('db:attachments:replace', data),
    open: (data) => ipcRenderer.invoke('db:attachments:open', data),
    stageClipboard: (data) => ipcRenderer.invoke('db:attachments:stageClipboard', data),
  },
  taskComments: {
    list: (params) => ipcRenderer.invoke('db:taskComments:list', params),
    add: (data) => ipcRenderer.invoke('db:taskComments:add', data),
    delete: (data) => ipcRenderer.invoke('db:taskComments:delete', data),
    unreadCounts: (params) => ipcRenderer.invoke('db:taskComments:unreadCounts', params),
  },
  subtaskComments: {
    list: (params) => ipcRenderer.invoke('db:subtaskComments:list', params),
    add: (data) => ipcRenderer.invoke('db:subtaskComments:add', data),
    delete: (data) => ipcRenderer.invoke('db:subtaskComments:delete', data),
  },
  issueComments: {
    list: (params) => ipcRenderer.invoke('db:issueComments:list', params),
    add: (data) => ipcRenderer.invoke('db:issueComments:add', data),
    delete: (data) => ipcRenderer.invoke('db:issueComments:delete', data),
  },
  config: {
    getDbPath: () => ipcRenderer.invoke('config:db-path:get'),
    setDbPath: (data) => ipcRenderer.invoke('config:db-path:set', data),
    getAppSettings: () => ipcRenderer.invoke('config:app-settings:get'),
    setAppSettings: (data) => ipcRenderer.invoke('config:app-settings:set', data),
    discoverServers: (data) => ipcRenderer.invoke('config:server:discover', data),
    checkServerHealth: (data) => ipcRenderer.invoke('config:server:health', data),
  },
  connection: {
    // Synchronous on purpose - used once at bootstrap (see src/client-main.jsx).
    // to decide the `mode` prop passed into <App>, mirroring what
    // remote-main.jsx used to hardcode. Everything after first paint
    // should use the async calls below instead.
    getModeSync: () => ipcRenderer.sendSync('connection:get-mode-sync'),
    getMode: () => ipcRenderer.invoke('connection:get-mode'),
    setMode: (data) => ipcRenderer.invoke('connection:set-mode', data),
  },

  // ── Reminders ──
  sync: {
    pull: () => ipcRenderer.invoke('sync:pull'),
    queueStatus: () => ipcRenderer.invoke('sync:queue-status'),
    onSnapshotUpdated: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('sync:snapshot-updated', listener);
      return () => ipcRenderer.removeListener('sync:snapshot-updated', listener);
    },
    onQueueUpdated: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('sync:queue-updated', listener);
      return () => ipcRenderer.removeListener('sync:queue-updated', listener);
    },
  },
  server: {
    status: () => ipcRenderer.invoke('server:status'),
    start: (data) => ipcRenderer.invoke('server:start', data),
    stop: () => ipcRenderer.invoke('server:stop'),
    logs: () => ipcRenderer.invoke('server:logs'),
    getRemoteAccess: () => ipcRenderer.invoke('server:remote-access:get'),
    setRemoteAccess: (data) => ipcRenderer.invoke('server:remote-access:set', data),
    listBackups: () => ipcRenderer.invoke('server:backups:list'),
    createBackup: () => ipcRenderer.invoke('server:backups:create'),
    restoreBackup: (data) => ipcRenderer.invoke('server:backups:restore', data),
    onLog: (callback) => {
      const listener = (_event, entry) => callback(entry);
      ipcRenderer.on('server:log', listener);
      return () => ipcRenderer.removeListener('server:log', listener);
    },
  },
  reminders: {
    set: (data) => ipcRenderer.invoke('db:reminders:set', data),
    get: (data) => ipcRenderer.invoke('db:reminders:get', data),
    due: (params) => ipcRenderer.invoke('db:reminders:due', params),
  },
  notifications: {
    add: (data) => ipcRenderer.invoke('notifications:add', data),
    list: (data) => ipcRenderer.invoke('notifications:list', data),
    remove: (data) => ipcRenderer.invoke('notifications:remove', data),
    clear: (data) => ipcRenderer.invoke('notifications:clear', data),
    markAllRead: (data) => ipcRenderer.invoke('notifications:markAllRead', data),
  },

  // ── Menu event listeners ──
  onExportCsv: (callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on('menu:export-csv', listener);
    return () => ipcRenderer.removeListener('menu:export-csv', listener);
  },
});
