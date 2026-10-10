"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("northstar", Object.freeze({
  getSystemStatus: () => ipcRenderer.invoke("system:status"),
  getActivity: () => ipcRenderer.invoke("system:activity"),
  getDevices: () => ipcRenderer.invoke("system:devices"),
  setPowerProfile: (profile) => ipcRenderer.invoke("system:set-power-profile", profile),
  setChargeLimit: (enabled) => ipcRenderer.invoke("system:set-charge-limit", enabled),
  setFanProfile: (profile) => ipcRenderer.invoke("system:set-fan-profile", profile),
  requestHardwareAccess: () => ipcRenderer.invoke("system:request-hardware-access"),
  smartFan: Object.freeze({
    getState: () => ipcRenderer.invoke("fan:smart-state"),
    set: (enabled) => ipcRenderer.invoke("fan:smart-set", enabled)
  }),
  bench: Object.freeze({
    volumes: () => ipcRenderer.invoke("bench:volumes"),
    gpus: () => ipcRenderer.invoke("bench:gpus"),
    run: (request) => ipcRenderer.invoke("bench:run", request),
    cancel: () => ipcRenderer.invoke("bench:cancel"),
    onProgress: (callback) => {
      if (typeof callback !== "function") return;
      ipcRenderer.on("bench:progress", (_event, progress) => callback(progress));
    }
  }),
  update: Object.freeze({
    getState: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    openRelease: () => ipcRenderer.invoke("update:open"),
    install: () => ipcRenderer.invoke("update:install"),
    onChange: (callback) => {
      if (typeof callback !== "function") return;
      ipcRenderer.on("update:changed", (_event, state) => callback(state));
    }
  }),
  remote: Object.freeze({
    getStatus: () => ipcRenderer.invoke("remote:status"),
    pair: (options) => ipcRenderer.invoke("remote:pair", options),
    unpair: () => ipcRenderer.invoke("remote:unpair")
  }),
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
