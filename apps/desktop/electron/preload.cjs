// Narrow, typed bridge. The renderer never gets Node, the filesystem, or credentials.
const { contextBridge, ipcRenderer } = require("electron");
const on = (ch) => (cb) => {
  const h = (_e, v) => cb(v);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};
// Streaming: main sends "harness:token" {rid, delta} while a turn generates; rid ties deltas to
// the call that asked for them.
let nextRid = 0;
const withTokens = async (ch, payload, onToken) => {
  if (typeof onToken !== "function") return ipcRenderer.invoke(ch, payload);
  const rid = `r${Date.now().toString(36)}-${++nextRid}`;
  const h = (_e, v) => {
    if (v && v.rid === rid && typeof v.delta === "string") onToken(v.delta);
  };
  ipcRenderer.on("harness:token", h);
  try {
    return await ipcRenderer.invoke(ch, { ...payload, rid });
  } finally {
    ipcRenderer.removeListener("harness:token", h);
  }
};
contextBridge.exposeInMainWorld("eeg", {
  newSession: (onToken) => withTokens("harness:new", {}, onToken),
  reply: (payload, onToken) => withTokens("harness:reply", payload ?? {}, onToken),
  hud: () => ipcRenderer.invoke("harness:hud"),
  sessions: () => ipcRenderer.invoke("harness:sessions"),
  info: () => ipcRenderer.invoke("harness:info"),
  rate: (r) => ipcRenderer.invoke("harness:rate", r),
  exportLogs: () => ipcRenderer.invoke("harness:exportLogs"),
  study: {
    status: () => ipcRenderer.invoke("study:status"),
    enable: () => ipcRenderer.invoke("study:enable"),
    disable: () => ipcRenderer.invoke("study:disable"),
    hash: () => ipcRenderer.invoke("study:hash"),
    unseal: (confirm) => ipcRenderer.invoke("study:unseal", confirm),
    reissue: (n, confirm, reason) => ipcRenderer.invoke("study:reissue", { n, confirm, reason }),
    cancelReissue: () => ipcRenderer.invoke("study:cancelReissue"),
  },
  uploads: {
    status: () => ipcRenderer.invoke("uploads:status"),
    flush: () => ipcRenderer.invoke("uploads:flush"),
  },
  providers: {
    status: () => ipcRenderer.invoke("providers:status"),
    select: (provider, model) => ipcRenderer.invoke("providers:select", { provider, model }),
    setApiKey: (provider, key) => ipcRenderer.invoke("providers:apiKey", { provider, key }),
    setEndpoint: (provider, url) => ipcRenderer.invoke("providers:endpoint", { provider, url }),
    setExtractorPrompt: (version) => ipcRenderer.invoke("providers:extractorPrompt", { version }),
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
