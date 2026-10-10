"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const WebSocket = require("ws");

const PLATFORM_NAMES = Object.freeze({ darwin: "macOS", win32: "Windows", linux: "Linux" });

function normalizeServerUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["https:", ...(localHttp ? ["http:"] : [])].includes(url.protocol)) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function createRemoteAgent({
  safeStorage,
  storagePath,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = WebSocket,
  getSystemStatus,
  setPowerProfile,
  setChargeLimit,
  confirmCommand,
  runTerminal,
  now = Date.now,
  platform = process.platform,
  onStatusChange = () => {}
}) {
  let configuration = { serverUrl: "", device: null };
  let socket = null;
  let reconnectTimer = null;
  let telemetryTimer = null;
  let reconnectDelay = 1000;
  let stopped = true;
  let initialization;
  const isSecureStorageAvailable = () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (platform !== "linux") return true;
    if (typeof safeStorage.getSelectedStorageBackend !== "function") return false;
    return !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend());
  };

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        try {
          const stored = JSON.parse(await fs.readFile(storagePath, "utf8"));
          if (typeof stored.serverUrl !== "string") throw new Error("Saved remote connection settings are invalid");
          configuration.serverUrl = normalizeServerUrl(stored.serverUrl) || "";
          if (typeof stored.encryptedDevice === "string" && isSecureStorageAvailable()) {
            const device = JSON.parse(safeStorage.decryptString(Buffer.from(stored.encryptedDevice, "base64")));
            if (typeof device.id === "string" && typeof device.token === "string"
                && typeof device.name === "string" && typeof device.platform === "string") {
              configuration.device = device;
            }
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      })();
    }
    await initialization;
  }

  async function persist() {
    await fs.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
    const stored = { serverUrl: configuration.serverUrl };
    if (configuration.device) {
      if (!isSecureStorageAvailable()) throw new Error("OS-backed secure storage is unavailable");
      stored.encryptedDevice = safeStorage.encryptString(JSON.stringify(configuration.device)).toString("base64");
    }
    const temporaryPath = `${storagePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, storagePath);
  }

  function status() {
    return {
      configured: Boolean(configuration.serverUrl),
      serverUrl: configuration.serverUrl,
      paired: Boolean(configuration.device),
      device: configuration.device ? {
        id: configuration.device.id,
        name: configuration.device.name,
        platform: configuration.device.platform
      } : null,
      connected: Boolean(socket && socket.readyState === WebSocketImpl.OPEN)
    };
  }

  function notifyStatus() {
    onStatusChange(status());
  }

  function sendTelemetry() {
    if (!socket || socket.readyState !== WebSocketImpl.OPEN) return;
    Promise.resolve(getSystemStatus()).then((data) => {
      if (socket && socket.readyState === WebSocketImpl.OPEN) {
        socket.send(JSON.stringify({ type: "telemetry", data }));
      }
    }).catch((error) => {
      console.error("Unable to publish computer status:", error.message);
    });
  }

  let terminalGrant = null;

  async function handleCommand(message) {
    if (!message || message.type !== "command" || typeof message.requestId !== "string"
        || !/^[0-9a-f-]{36}$/i.test(message.requestId) || !message.command) return;
    const requestedBy = typeof message.requestedBy === "string" && /^[A-Za-z0-9-]{1,39}$/.test(message.requestedBy)
      ? message.requestedBy
      : "your Northstar account";
    let result = { ok: false, reason: "unsupported-command" };
    if (message.command.type === "power-profile"
        && ["Efficiency", "Balanced", "Performance"].includes(message.command.profile)) {
      const profile = message.command.profile;
      const approved = await confirmCommand({
        title: "Allow remote power change?",
        message: `@${requestedBy} requested the ${profile} power profile.`,
        detail: "Northstar will ask the operating system to apply this profile. This approval is only for this change.",
        confirmLabel: "Apply power profile"
      });
      if (approved) result = await setPowerProfile(profile);
      else result = { ok: false, reason: "declined-on-device" };
    } else if (message.command.type === "charge-limit" && typeof message.command.enabled === "boolean") {
      const enabled = message.command.enabled;
      const approved = await confirmCommand({
        title: "Allow remote battery change?",
        message: `@${requestedBy} requested ${enabled ? "an 80% battery charge limit" : "removing the battery charge limit"}.`,
        detail: "This change will only be applied if the operating system exposes a writable control.",
        confirmLabel: "Apply battery setting"
      });
      if (approved) result = await setChargeLimit(enabled);
      else result = { ok: false, reason: "declined-on-device" };
    }
    if (message.command.type === "terminal" && typeof message.command.command === "string"
        && message.command.command.length <= 500 && typeof runTerminal === "function") {
      if (!terminalGrant || terminalGrant.user !== requestedBy || terminalGrant.expiresAt <= now()) {
        terminalGrant = null;
        const approved = await confirmCommand({
          title: "Allow remote terminal access?",
          message: `@${requestedBy} wants to run commands on this computer for 10 minutes.`,
          detail: `First command: ${message.command.command}\n\nOnly approve this if you started it. Commands run with your user account's permissions.`,
          confirmLabel: "Allow for 10 minutes"
        });
        if (approved) terminalGrant = { user: requestedBy, expiresAt: now() + 10 * 60 * 1000 };
      }
      result = terminalGrant ? await runTerminal(message.command.command) : { ok: false, reason: "declined-on-device" };
    }
    if (socket && socket.readyState === WebSocketImpl.OPEN) {
      socket.send(JSON.stringify({ type: "command-result", requestId: message.requestId, result }));
    }
  }

  function scheduleReconnect() {
    if (stopped || !configuration.device || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function connect() {
    if (stopped || !configuration.device || socket) return;
    const endpoint = new URL("/device", configuration.serverUrl);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const currentSocket = new WebSocketImpl(endpoint, {
      headers: { Authorization: `Bearer ${configuration.device.token}` },
      handshakeTimeout: 10000,
      maxPayload: 16 * 1024
    });
    socket = currentSocket;
    currentSocket.on("open", () => {
      reconnectDelay = 1000;
      sendTelemetry();
      telemetryTimer = setInterval(sendTelemetry, 30000);
      notifyStatus();
    });
    currentSocket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      void handleCommand(message).catch((error) => {
        console.error("Remote hardware request failed:", error.message);
        if (typeof message.requestId === "string" && currentSocket.readyState === WebSocketImpl.OPEN) {
          currentSocket.send(JSON.stringify({
            type: "command-result",
            requestId: message.requestId,
            result: { ok: false, reason: "local-command-failed" }
          }));
        }
      });
    });
    currentSocket.on("close", (code) => {
      if (socket !== currentSocket) return;
      socket = null;
      if (telemetryTimer) clearInterval(telemetryTimer);
      telemetryTimer = null;
      if (code === 4001 && !stopped && configuration.device) {
        stopped = true;
        configuration.device = null;
        void persist().catch((error) => console.error("Could not clear revoked remote credentials:", error.message));
      }
      notifyStatus();
      if (code !== 4001) scheduleReconnect();
    });
    currentSocket.on("unexpected-response", (_request, response) => {
      if (response.statusCode !== 401 || socket !== currentSocket) return;
      stopped = true;
      currentSocket.terminate();
      socket = null;
      configuration.device = null;
      void persist().then(notifyStatus).catch((error) => console.error("Could not clear rejected remote credentials:", error.message));
    });
    currentSocket.on("error", (error) => {
      console.error("Northstar remote connection error:", error.message);
    });
  }

  async function start() {
    await initialize();
    stopped = false;
    if (configuration.device) connect();
    return status();
  }

  async function pair({ serverUrl, code, name }) {
    await initialize();
    const normalizedUrl = normalizeServerUrl(serverUrl);
    if (!normalizedUrl) return { ok: false, reason: "invalid-server-url" };
    if (!isSecureStorageAvailable()) return { ok: false, reason: "secure-storage-unavailable" };
    if (typeof code !== "string" || !/^[A-Za-z0-9 -]{8,16}$/.test(code.trim())) {
      return { ok: false, reason: "invalid-pairing-code" };
    }
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
      return { ok: false, reason: "invalid-device-name" };
    }
    const platformName = PLATFORM_NAMES[platform];
    if (!platformName) return { ok: false, reason: "unsupported-platform" };
    let response;
    try {
      response = await fetchImpl(new URL("/api/device/pair", normalizedUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: code.trim(), name: name.trim(), platform: platformName }),
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      return { ok: false, reason: "server-unreachable" };
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.id !== "string" || typeof data.deviceToken !== "string") {
      return { ok: false, reason: data.error || "pairing-failed" };
    }
    stopped = true;
    if (socket) socket.close(1000, "Replaced pairing");
    socket = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (telemetryTimer) clearInterval(telemetryTimer);
    reconnectTimer = null;
    telemetryTimer = null;
    configuration = {
      serverUrl: normalizedUrl,
      device: { id: data.id, token: data.deviceToken, name: data.name, platform: data.platform }
    };
    await persist();
    stopped = false;
    connect();
    notifyStatus();
    return { ok: true, device: status().device };
  }

  async function unpair() {
    await initialize();
    if (!configuration.device) return { ok: true };
    const { serverUrl, device } = configuration;
    let response;
    try {
      response = await fetchImpl(new URL("/api/device/unpair", serverUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${device.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      return { ok: false, reason: "server-unreachable" };
    }
    if (!response.ok && response.status !== 401) return { ok: false, reason: "server-revocation-failed" };
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (telemetryTimer) clearInterval(telemetryTimer);
    reconnectTimer = null;
    telemetryTimer = null;
    if (socket) socket.close(4001, "Device access revoked");
    socket = null;
    configuration.device = null;
    await persist();
    notifyStatus();
    return { ok: true };
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (telemetryTimer) clearInterval(telemetryTimer);
    reconnectTimer = null;
    telemetryTimer = null;
    if (socket) socket.close(1000, "Northstar is closing");
    socket = null;
    notifyStatus();
  }

  return { start, pair, unpair, stop, status: async () => { await initialize(); return status(); } };
}

module.exports = { createRemoteAgent, normalizeServerUrl };
