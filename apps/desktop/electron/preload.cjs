// Narrow, typed bridge. The renderer never gets Node, the filesystem, or credentials.
const { contextBridge, ipcRenderer } = require("electron");
const on = (ch) => (cb) => {
  const h = (_e, v) => cb(v);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};
contextBridge.exposeInMainWorld("eeg", {
  newSession: () => ipcRenderer.invoke("harness:new"),
  reply: (payload) => ipcRenderer.invoke("harness:reply", payload),
  hud: () => ipcRenderer.invoke("harness:hud"),
  sessions: () => ipcRenderer.invoke("harness:sessions"),
  info: () => ipcRenderer.invoke("harness:info"),
  providers: {
    status: () => ipcRenderer.invoke("providers:status"),
    select: (provider, model) => ipcRenderer.invoke("providers:select", { provider, model }),
    setApiKey: (provider, key) => ipcRenderer.invoke("providers:apiKey", { provider, key }),
    setEndpoint: (provider, url) => ipcRenderer.invoke("providers:endpoint", { provider, url }),
    logout: (provider) => ipcRenderer.invoke("providers:logout", { provider }),
    login: (provider) => ipcRenderer.invoke("providers:login", { provider }),
    cancelLogin: () => ipcRenderer.invoke("providers:cancelLogin"),
    answer: (id, value) => ipcRenderer.invoke("auth:answer", { id, value }),
    onAuthEvent: on("auth:event"),
    onAuthPrompt: on("auth:prompt"),
    onAuthPromptDone: on("auth:promptDone"),
  },
  platform: process.platform,
  kind: "electron",
  credentialNote: "Stored only on this Mac, encrypted with your login Keychain.",
});
