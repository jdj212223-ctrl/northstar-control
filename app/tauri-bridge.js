"use strict";

// Recreates the window.northstar API on top of Tauri IPC. It does nothing in
// Electron (which preloads its own) or in a plain browser preview.
(() => {
  const tauri = window.__TAURI__;
  if (window.northstar || !tauri || !tauri.core) return;
  const invoke = (name, args) => tauri.core.invoke(name, args);
  const listen = (name, callback) => {
    if (typeof callback !== "function") return;
    tauri.event.listen(name, (event) => callback(event.payload));
  };

  window.northstar = Object.freeze({
    getSystemStatus: () => invoke("system_status"),
    getActivity: () => invoke("system_activity"),
    getDevices: () => invoke("system_devices"),
    setPowerProfile: (profile) => invoke("set_power_profile", { profile }),
    setChargeLimit: (enabled) => invoke("set_charge_limit", { enabled }),
    setFanProfile: (profile) => invoke("set_fan_profile", { profile }),
    requestHardwareAccess: () => invoke("request_hardware_access"),
    smartFan: Object.freeze({
      getState: () => invoke("fan_smart_state"),
      set: (enabled) => invoke("fan_smart_set", { enabled })
    }),
    ssd: Object.freeze({
      health: () => invoke("ssd_health")
    }),
    bench: Object.freeze({
      volumes: () => invoke("bench_volumes"),
      gpus: () => invoke("bench_gpus"),
      run: (request) => invoke("bench_run", { request }),
      cancel: () => invoke("bench_cancel"),
      onProgress: (callback) => listen("bench:progress", callback)
    }),
    update: Object.freeze({
      getState: () => invoke("update_state"),
      check: () => invoke("update_check"),
      openRelease: () => invoke("update_open"),
      install: () => invoke("update_install"),
      onChange: (callback) => listen("update:changed", callback)
    }),
    remote: Object.freeze({
      getStatus: () => invoke("remote_status"),
      pair: (options) => invoke("remote_pair", { options }),
      unpair: () => invoke("remote_unpair")
    }),
    github: Object.freeze({
      getStatus: () => invoke("github_status"),
      saveClientId: (clientId) => invoke("github_save_client_id", { clientId }),
      begin: () => invoke("github_begin"),
      poll: () => invoke("github_poll"),
      cancel: () => invoke("github_cancel"),
      signOut: () => invoke("github_sign_out"),
      openRegistration: () => invoke("github_open_registration"),
      openVerification: () => invoke("github_open_verification")
    })
  });
})();
