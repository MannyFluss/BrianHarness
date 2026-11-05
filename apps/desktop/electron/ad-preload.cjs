// E7 Director Mac shell preload: a narrow bridge for the camera tracker. Numbers and enum strings only.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bhAdMac", {
  cameraPermission: () => ipcRenderer.invoke("ad:camera-permission"),
  requestCamera: () => ipcRenderer.invoke("ad:camera-request"),
  screen: () => ipcRenderer.invoke("ad:screen"),
  h1: (report) => ipcRenderer.send("ad:h1", report),
});
