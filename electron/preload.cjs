"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("northstar", Object.freeze({
  getSystemStatus: () => ipcRenderer.invoke("system:status"),
  getDevices: () => ipcRenderer.invoke("system:devices"),
  setPowerProfile: (profile) => ipcRenderer.invoke("system:set-power-profile", profile),
  setChargeLimit: (enabled) => ipcRenderer.invoke("system:set-charge-limit", enabled),
  requestHardwareAccess: () => ipcRenderer.invoke("system:request-hardware-access"),
  github: Object.freeze({
    getStatus: () => ipcRenderer.invoke("github:status"),
    saveClientId: (clientId) => ipcRenderer.invoke("github:save-client-id", clientId),
    begin: () => ipcRenderer.invoke("github:begin"),
    poll: () => ipcRenderer.invoke("github:poll"),
    cancel: () => ipcRenderer.invoke("github:cancel"),
    signOut: () => ipcRenderer.invoke("github:sign-out"),
    openRegistration: () => ipcRenderer.invoke("github:open-registration"),
    openVerification: () => ipcRenderer.invoke("github:open-verification")
  })
}));
