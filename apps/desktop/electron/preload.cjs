// Narrow, typed bridge. The renderer never gets Node or the filesystem.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("eeg", {
  newSession: () => ipcRenderer.invoke("harness:new"),
  reply: (payload) => ipcRenderer.invoke("harness:reply", payload),
  hud: () => ipcRenderer.invoke("harness:hud"),
  sessions: () => ipcRenderer.invoke("harness:sessions"),
  info: () => ipcRenderer.invoke("harness:info"),
  platform: process.platform,
});
