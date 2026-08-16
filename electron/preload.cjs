const { contextBridge, ipcRenderer, webUtils } = require("electron");

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).then((response) => {
    if (!response?.ok) throw new Error(response?.error ?? "Unknown error");
    return response.value;
  });
}

contextBridge.exposeInMainWorld("hub", {
  getProjectDir: () => invoke("project:get"),
  pickProjectDir: () => invoke("project:pick"),

  listChats: (projectDir) => invoke("chats:list", projectDir),
  setPinned: (sessionId, pinned) => invoke("chats:setPinned", sessionId, pinned),
  loadHistory: (sessionId, projectDir) => invoke("chat:history", sessionId, projectDir),

  openChat: (config) => invoke("chat:open", config),
  closeChat: (chatId) => invoke("chat:close", chatId),
  send: (chatId, text, attachments) => invoke("chat:send", chatId, text, attachments),

  pickAttachments: () => invoke("attachments:pick"),
  describeAttachment: (filePath) => invoke("attachments:describe", filePath),
  attachmentLimit: () => invoke("attachments:limit"),
  thumbnail: (filePath) => invoke("attachments:thumbnail", filePath),
  saveCapture: (capture) => invoke("capture:save", capture),

  // Electron 32+ removed File.path; this is the supported replacement and it
  // must run in the preload with the original File instance.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  interrupt: (chatId) => invoke("chat:interrupt", chatId),

  setPermissionMode: (chatId, mode) => invoke("chat:setPermissionMode", chatId, mode),
  setModel: (chatId, model) => invoke("chat:setModel", chatId, model),
  setEffort: (chatId, effort) => invoke("chat:setEffort", chatId, effort),

  listCommands: (chatId) => invoke("chat:commands", chatId),
  listModels: (chatId) => invoke("chat:models", chatId),
  contextUsage: (chatId) => invoke("chat:contextUsage", chatId),
  mcpStatus: (chatId) => invoke("chat:mcpStatus", chatId),

  renameChat: (sessionId, title, projectDir) =>
    invoke("chat:rename", sessionId, title, projectDir),
  deleteChat: (sessionId, projectDir) => invoke("chat:delete", sessionId, projectDir),

  respondToPermission: (chatId, requestId, decision) =>
    invoke("permission:respond", chatId, requestId, decision),

  listFolders: () => invoke("folders:get"),
  saveFolders: (folders) => invoke("folders:save", folders),

  resolveClipboardFiles: (files) => invoke("clipboard:resolve", files),

  authStatus: () => invoke("auth:status"),
  startLogin: (mode) => invoke("auth:login", mode),
  submitLoginCode: (code) => invoke("auth:submitCode", code),
  cancelLogin: () => invoke("auth:cancelLogin"),
  logout: () => invoke("auth:logout"),
  setAuthToken: (token) => invoke("auth:setToken", token),

  appInfo: () => invoke("app:info"),
  openLogFolder: () => invoke("app:openLogFolder"),
  logMessage: (level, message) => invoke("app:log", level, message),

  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
});
