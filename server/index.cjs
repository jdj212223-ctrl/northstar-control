"use strict";

const { createHash, randomBytes, randomInt, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { isIP } = require("node:net");
const { DatabaseSync } = require("node:sqlite");
const { WebSocketServer, WebSocket } = require("ws");

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const PROFILE_URL = "https://api.github.com/user";
const DEVICE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size === 0) return resolve({});
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        return reject(Object.assign(new Error("Expected JSON request body"), { statusCode: 415 }));
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
  }
  return cookies;
}

function accountFromGitHub(value) {
  if (!value || typeof value.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(value.login)) return null;
  if (!Number.isSafeInteger(value.id) || value.id <= 0) return null;
  if (typeof value.avatar_url !== "string" || typeof value.html_url !== "string") return null;
  const avatar = new URL(value.avatar_url);
  const profile = new URL(value.html_url);
  if (avatar.protocol !== "https:" || avatar.hostname !== "avatars.githubusercontent.com"
      || profile.protocol !== "https:" || profile.hostname !== "github.com") return null;
  return {
    id: String(value.id),
    login: value.login,
    name: typeof value.name === "string" && value.name.trim() ? value.name.slice(0, 120) : value.login,
    avatarUrl: avatar.href,
    profileUrl: profile.href
  };
}

function validDeviceName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const platform = ["macOS", "Windows", "Linux"].includes(value.platform) ? value.platform : null;
  if (!platform) return null;
  const numberOrNull = (input, minimum, maximum) => Number.isFinite(input) && input >= minimum && input <= maximum ? input : null;
  const battery = value.battery && typeof value.battery === "object"
    ? {
      percent: numberOrNull(value.battery.percent, 0, 100),
      status: typeof value.battery.status === "string" ? value.battery.status.slice(0, 40) : "Unknown"
    }
    : null;
  const profile = value.powerProfile && typeof value.powerProfile === "object"
    ? {
      current: typeof value.powerProfile.current === "string" ? value.powerProfile.current.slice(0, 30) : "Unknown",
      available: Array.isArray(value.powerProfile.available)
        ? value.powerProfile.available.filter((item) => ["Efficiency", "Balanced", "Performance"].includes(item))
        : []
    }
    : null;
  return {
    platform,
    hostname: typeof value.hostname === "string" ? value.hostname.slice(0, 120) : "Computer",
    cpuLoad: numberOrNull(value.cpuLoad, 0, 100),
    uptimeSeconds: numberOrNull(value.uptimeSeconds, 0, Number.MAX_SAFE_INTEGER),
    memoryTotalBytes: numberOrNull(value.memoryTotalBytes, 0, Number.MAX_SAFE_INTEGER),
    memoryFreeBytes: numberOrNull(value.memoryFreeBytes, 0, Number.MAX_SAFE_INTEGER),
    battery,
    temperatureC: numberOrNull(value.temperatureC, -30, 130),
    fanRpm: numberOrNull(value.fanRpm, 0, 100000),
    chargeLimit: numberOrNull(value.chargeLimit, 0, 100),
    writableChargeLimit: value.writableChargeLimit === true,
    powerProfile: profile
  };
}

function createRemoteServer({
  allowedOrigins = ["https://jdj212223-ctrl.github.io"],
  clientId = process.env.GITHUB_CLIENT_ID || "Ov23liuh8l0EjSIdKmzt",
  databasePath = process.env.NORTHSTAR_DB_PATH || path.join(process.cwd(), "server-data", "northstar.sqlite"),
  fetchImpl = globalThis.fetch,
  trustProxy = false,
  now = Date.now
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      telemetry_json TEXT
    );
  `);

  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    account_json TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  // Sessions live in SQLite (keyed by a hash of the cookie value) so sign-ins survive restarts and deploys.
  const sessions = {
    get(id) {
      const row = db.prepare("SELECT account_json, csrf_token, expires_at FROM sessions WHERE id_hash = ?").get(digest(id));
      return row ? { account: JSON.parse(row.account_json), csrfToken: row.csrf_token, expiresAt: row.expires_at } : undefined;
    },
    set(id, value) {
      db.prepare("INSERT OR REPLACE INTO sessions (id_hash, account_json, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
        .run(digest(id), JSON.stringify(value.account), value.csrfToken, value.expiresAt);
    },
    delete(id) { db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(digest(id)); },
    get size() {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
      return db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count;
    }
  };
  const flows = new Map();
  const pairCodes = new Map();
  const connectedDevices = new Map();
  const pendingCommands = new Map();
  const rateLimits = new Map();
  const allowed = new Set(allowedOrigins);
  const httpServer = http.createServer((request, response) => {
    void handleHttp(request, response);
  });
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

  function getSession(request) {
    const sessionId = parseCookies(request.headers.cookie).get("__Host-northstar_session");
    if (!sessionId) return null;
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt <= now()) {
      sessions.delete(sessionId);
      return null;
    }
    return { id: sessionId, ...session };
  }

  function cookieHeader(token, maxAge) {
    return `__Host-northstar_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
  }

  function corsHeaders(origin) {
    if (!origin || !allowed.has(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "Content-Type, X-Northstar-CSRF",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Vary": "Origin"
    };
  }

  function checkOrigin(request) {
    const origin = request.headers.origin;
    return typeof origin === "string" && allowed.has(origin);
  }

  function allowRateLimit(request, key, limit, windowMs, identity = "") {
    let address = request.socket.remoteAddress || "unknown";
    if (trustProxy && typeof request.headers["x-forwarded-for"] === "string") {
      const forwardedAddress = request.headers["x-forwarded-for"].split(",")[0].trim();
      if (isIP(forwardedAddress)) address = forwardedAddress;
    }
    const currentTime = now();
    if (rateLimits.size > 5000) {
      for (const [existingKey, entry] of rateLimits) {
        if (entry.resetAt <= currentTime) rateLimits.delete(existingKey);
      }
    }
    const storageKey = `${key}:${identity}:${address}`;
    const current = rateLimits.get(storageKey);
    if (!current || current.resetAt <= currentTime) {
      rateLimits.set(storageKey, { count: 1, resetAt: currentTime + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  function checkCsrf(request, session) {
    return checkOrigin(request) && request.headers["x-northstar-csrf"] === session.csrfToken;
  }

  function requireSession(request, response, mutation = false, headers = {}) {
    const session = getSession(request);
    if (!session) {
      json(response, 401, { error: "sign-in-required" }, headers);
      return null;
    }
    if (mutation && !checkCsrf(request, session)) {
      json(response, 403, { error: "csrf-check-failed" }, headers);
      return null;
    }
    return session;
  }

  async function handleHttp(request, response) {
    const origin = request.headers.origin;
    if (origin && !allowed.has(origin)) return json(response, 403, { error: "origin-not-allowed" });
    const headers = corsHeaders(origin);
    if (request.method === "OPTIONS") {
      if (!checkOrigin(request)) return json(response, 403, { error: "origin-not-allowed" });
      response.writeHead(204, headers);
      return response.end();
    }
    let url;
    try {
      url = new URL(request.url, "http://localhost");
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /health") return json(response, 200, { ok: true }, headers);
      if (route === "GET /api/auth/session") {
        const session = getSession(request);
        return json(response, 200, {
          account: session ? session.account : null,
          csrfToken: session ? session.csrfToken : null
        }, headers);
      }
      if (route === "POST /api/auth/device/start") {
        if (!checkOrigin(request)) return json(response, 403, { error: "origin-not-allowed" }, headers);
        if (!allowRateLimit(request, "auth-start", 10, 60 * 1000)) return json(response, 429, { error: "rate-limit-exceeded" }, headers);
        for (const [key, flow] of flows) if (flow.expiresAt <= now()) flows.delete(key);
        if (flows.size >= 10000) return json(response, 503, { error: "too-many-sign-in-flows" }, headers);
        if (!/^[A-Za-z0-9._-]{8,128}$/.test(clientId)) return json(response, 503, { error: "github-client-id-not-configured" }, headers);
        const githubResponse = await fetchImpl(DEVICE_CODE_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Northstar-Control" },
          body: JSON.stringify({ client_id: clientId, scope: "read:user" }),
          signal: AbortSignal.timeout(10000)
        });
        const data = await githubResponse.json();
        if (!githubResponse.ok || data.error || typeof data.device_code !== "string"
            || typeof data.user_code !== "string" || data.verification_uri !== "https://github.com/login/device") {
          return json(response, 502, { error: "github-device-flow-start-failed" }, headers);
        }
        const expiresIn = Number(data.expires_in);
        const interval = Number(data.interval);
        if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 3600
            || !Number.isFinite(interval) || interval < 1 || interval > 300) {
          return json(response, 502, { error: "github-device-flow-invalid-response" }, headers);
        }
        const flowId = randomBytes(32).toString("base64url");
        flows.set(flowId, {
          deviceCode: data.device_code,
          expiresAt: now() + expiresIn * 1000,
          interval: Math.floor(interval),
          nextPollAt: 0
        });
        return json(response, 200, {
          flowId,
          userCode: data.user_code,
          verificationUrl: "https://github.com/login/device",
          expiresIn,
          interval
        }, headers);
      }
      if (route === "POST /api/auth/device/poll") {
        if (!checkOrigin(request)) return json(response, 403, { error: "origin-not-allowed" });
        const body = await readJson(request);
        if (typeof body.flowId !== "string" || body.flowId.length > 100) return json(response, 400, { error: "invalid-flow" }, headers);
        const flow = flows.get(body.flowId);
        if (!flow) return json(response, 404, { status: "not-found" }, headers);
        if (now() >= flow.expiresAt) {
          flows.delete(body.flowId);
          return json(response, 200, { status: "expired" }, headers);
        }
        if (now() < flow.nextPollAt) return json(response, 200, { status: "pending", retryAfterMs: flow.nextPollAt - now() }, headers);
        flow.nextPollAt = now() + flow.interval * 1000;
        const tokenResponse = await fetchImpl(ACCESS_TOKEN_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Northstar-Control" },
          body: JSON.stringify({
            client_id: clientId,
            device_code: flow.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code"
          }),
          signal: AbortSignal.timeout(10000)
        });
        const tokenData = await tokenResponse.json();
        if (tokenData.error === "authorization_pending") {
          return json(response, 200, { status: "pending", retryAfterMs: flow.interval * 1000 }, headers);
        }
        if (tokenData.error === "slow_down") {
          flow.interval = Math.min(flow.interval + 5, 60);
          return json(response, 200, { status: "pending", retryAfterMs: flow.interval * 1000 }, headers);
        }
        if (tokenData.error === "access_denied" || tokenData.error === "expired_token") {
          flows.delete(body.flowId);
          return json(response, 200, { status: tokenData.error === "access_denied" ? "denied" : "expired" }, headers);
        }
        if (!tokenResponse.ok || typeof tokenData.access_token !== "string") {
          flows.delete(body.flowId);
          return json(response, 502, { status: "failed" }, headers);
        }
        const profileResponse = await fetchImpl(PROFILE_URL, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${tokenData.access_token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Northstar-Control"
          },
          signal: AbortSignal.timeout(10000)
        });
        const account = accountFromGitHub(await profileResponse.json());
        flows.delete(body.flowId);
        if (!profileResponse.ok || !account) return json(response, 502, { status: "profile-failed" }, headers);
        const sessionId = randomBytes(32).toString("base64url");
        const csrfToken = randomBytes(32).toString("base64url");
        if (sessions.size >= 100000) return json(response, 503, { error: "too-many-active-sessions" }, headers);
        sessions.set(sessionId, { account, csrfToken, expiresAt: now() + SESSION_TTL_MS });
        return json(response, 200, { status: "authorized", account, csrfToken }, {
          ...headers,
          "Set-Cookie": cookieHeader(sessionId, SESSION_TTL_MS / 1000)
        });
      }
      if (route === "POST /api/auth/device/cancel") {
        if (!checkOrigin(request)) return json(response, 403, { error: "origin-not-allowed" }, headers);
        const body = await readJson(request);
        if (typeof body.flowId !== "string") return json(response, 400, { error: "invalid-flow" }, headers);
        flows.delete(body.flowId);
        return json(response, 200, { ok: true }, headers);
      }
      if (route === "POST /api/auth/logout") {
        const session = requireSession(request, response, true, headers);
        if (!session) return;
        sessions.delete(session.id);
        return json(response, 200, { ok: true }, { ...headers, "Set-Cookie": cookieHeader("", 0) });
      }
      if (route === "POST /api/device/pair") {
        if (!allowRateLimit(request, "device-pair", 12, 60 * 1000)) return json(response, 429, { error: "rate-limit-exceeded" }, headers);
        for (const [key, pair] of pairCodes) if (pair.expiresAt <= now()) pairCodes.delete(key);
        const body = await readJson(request);
        const code = typeof body.code === "string" ? body.code.toUpperCase().replace(/[\s-]/g, "") : "";
        const pair = pairCodes.get(code);
        if (!pair || pair.expiresAt <= now()) {
          pairCodes.delete(code);
          return json(response, 401, { error: "pairing-code-invalid-or-expired" }, headers);
        }
        if (!validDeviceName(body.name) || !["macOS", "Windows", "Linux"].includes(body.platform)) {
          return json(response, 400, { error: "invalid-device-details" }, headers);
        }
        pairCodes.delete(code);
        const id = randomUUID();
        const deviceToken = randomBytes(32).toString("base64url");
        const createdAt = now();
        db.prepare("INSERT INTO devices (id, owner_id, name, platform, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, pair.ownerId, body.name.trim(), body.platform, digest(deviceToken), createdAt, createdAt);
        return json(response, 201, { id, deviceToken, name: body.name.trim(), platform: body.platform }, headers);
      }
      if (route === "POST /api/device/unpair") {
        const authorization = request.headers.authorization || "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const device = token.length <= 128
          ? db.prepare("SELECT id FROM devices WHERE token_hash = ?").get(digest(token))
          : null;
        if (!device) return json(response, 401, { error: "device-authentication-failed" }, headers);
        const socket = connectedDevices.get(device.id);
        connectedDevices.delete(device.id);
        if (socket?.readyState === WebSocket.OPEN) socket.close(4001, "Device access revoked");
        db.prepare("DELETE FROM devices WHERE id = ?").run(device.id);
        return json(response, 200, { ok: true }, headers);
      }
      if (route === "POST /api/device/pair-code") {
        const session = requireSession(request, response, true, headers);
        if (!session) return;
        if (!allowRateLimit(request, "pair-code", 10, 5 * 60 * 1000, session.account.id)) return json(response, 429, { error: "rate-limit-exceeded" }, headers);
        for (const [key, pair] of pairCodes) if (pair.expiresAt <= now()) pairCodes.delete(key);
        if (pairCodes.size >= 10000) return json(response, 503, { error: "too-many-pairing-codes" }, headers);
        const ownedCount = db.prepare("SELECT COUNT(*) AS count FROM devices WHERE owner_id = ?").get(session.account.id).count;
        if (ownedCount >= 50) return json(response, 409, { error: "device-limit-reached" }, headers);
        const body = await readJson(request);
        if (body.name !== undefined && !validDeviceName(body.name)) return json(response, 400, { error: "invalid-device-name" }, headers);
        let code = "";
        do {
          code = Array.from({ length: 8 }, () => DEVICE_CODE_ALPHABET[randomInt(DEVICE_CODE_ALPHABET.length)]).join("");
        } while (pairCodes.has(code));
        pairCodes.set(code, {
          ownerId: session.account.id,
          name: typeof body.name === "string" ? body.name.trim() : null,
          expiresAt: now() + PAIR_CODE_TTL_MS
        });
        return json(response, 201, { code, expiresIn: PAIR_CODE_TTL_MS / 1000 }, headers);
      }
      if (route === "GET /api/devices") {
        const session = requireSession(request, response, false, headers);
        if (!session) return;
        const devices = db.prepare("SELECT id, name, platform, created_at, last_seen, telemetry_json FROM devices WHERE owner_id = ? ORDER BY created_at DESC")
          .all(session.account.id)
          .map((device) => {
            let telemetry = null;
            try { telemetry = device.telemetry_json ? JSON.parse(device.telemetry_json) : null; } catch { telemetry = null; }
            return {
              id: device.id,
              name: device.name,
              platform: device.platform,
              createdAt: device.created_at,
              lastSeen: device.last_seen,
              online: connectedDevices.has(device.id) && now() - device.last_seen < 30000,
              telemetry
            };
          });
        return json(response, 200, { devices }, headers);
      }
      const deviceMatch = url.pathname.match(/^\/api\/devices\/([0-9a-f-]{36})(?:\/(unpair|commands))?$/i);
      if (deviceMatch && request.method === "POST" && deviceMatch[2] === "unpair") {
        const session = requireSession(request, response, true, headers);
        if (!session) return;
        const id = deviceMatch[1];
        const owned = db.prepare("SELECT id FROM devices WHERE id = ? AND owner_id = ?").get(id, session.account.id);
        if (!owned) return json(response, 404, { error: "device-not-found" }, headers);
        const socket = connectedDevices.get(id);
        connectedDevices.delete(id);
        if (socket?.readyState === WebSocket.OPEN) socket.close(4001, "Device access revoked");
        db.prepare("DELETE FROM devices WHERE id = ?").run(id);
        return json(response, 200, { ok: true }, headers);
      }
      if (deviceMatch && request.method === "POST" && deviceMatch[2] === "commands") {
        const session = requireSession(request, response, true, headers);
        if (!session) return;
        const id = deviceMatch[1];
        const owned = db.prepare("SELECT id FROM devices WHERE id = ? AND owner_id = ?").get(id, session.account.id);
        if (!owned) return json(response, 404, { error: "device-not-found" }, headers);
        const socket = connectedDevices.get(id);
        if (!socket || socket.readyState !== WebSocket.OPEN) return json(response, 409, { error: "device-offline" }, headers);
        const body = await readJson(request);
        const command = validateCommand(body);
        if (!command) return json(response, 400, { error: "unsupported-command" }, headers);
        const requestId = randomUUID();
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingCommands.delete(requestId);
            resolve({ error: "device-command-timeout" });
          }, 15000);
          pendingCommands.set(requestId, (value) => {
            clearTimeout(timer);
            resolve(value);
          });
          socket.send(JSON.stringify({ type: "command", requestId, requestedBy: session.account.login, command }));
        });
        return json(response, result.error ? 504 : 200, result, headers);
      }
      return json(response, 404, { error: "not-found" }, headers);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      json(response, status, { error: status === 500 ? "internal-server-error" : error.message }, headers);
    }
  }

  function onSocketMessage(deviceId, socket, raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { socket.close(1007, "Invalid JSON"); return; }
    if (!message || typeof message !== "object") return socket.close(1007, "Invalid message");
    if (message.type === "telemetry") {
      const telemetry = boundedTelemetry(message.data);
      if (!telemetry) return socket.close(1008, "Invalid telemetry");
      db.prepare("UPDATE devices SET last_seen = ?, telemetry_json = ? WHERE id = ?")
        .run(now(), JSON.stringify(telemetry), deviceId);
      return;
    }
    if (message.type === "command-result" && typeof message.requestId === "string") {
      const resolve = pendingCommands.get(message.requestId);
      if (!resolve) return;
      pendingCommands.delete(message.requestId);
      const result = message.result && typeof message.result.ok === "boolean"
        ? { ok: message.result.ok, reason: typeof message.result.reason === "string" ? message.result.reason.slice(0, 80) : undefined }
        : { ok: false, reason: "invalid-device-response" };
      resolve(result);
    }
  }

  webSockets.on("connection", (socket, deviceId) => {
    const previous = connectedDevices.get(deviceId);
    if (previous && previous !== socket && previous.readyState === WebSocket.OPEN) previous.close(4002, "Reconnected elsewhere");
    connectedDevices.set(deviceId, socket);
    socket.on("message", (message) => onSocketMessage(deviceId, socket, message));
    socket.on("close", () => {
      if (connectedDevices.get(deviceId) === socket) connectedDevices.delete(deviceId);
    });
    socket.on("error", () => {
      if (connectedDevices.get(deviceId) === socket) connectedDevices.delete(deviceId);
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    let url;
    try { url = new URL(request.url, "http://localhost"); } catch { socket.destroy(); return; }
    if (url.pathname !== "/device" || (request.headers.origin && !allowed.has(request.headers.origin))) {
      socket.destroy();
      return;
    }
    const authorization = request.headers.authorization || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const record = token.length <= 128
      ? db.prepare("SELECT id FROM devices WHERE token_hash = ?").get(digest(token))
      : null;
    if (!record) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, record.id);
    });
  });

  return {
    server: httpServer,
    async close() {
      for (const socket of connectedDevices.values()) socket.close(1001, "Server shutting down");
      await new Promise((resolve) => httpServer.close(resolve));
      webSockets.close();
      db.close();
    }
  };
}

function validateCommand(body) {
  if (body?.type === "power-profile" && ["Efficiency", "Balanced", "Performance"].includes(body.profile)) {
    return { type: body.type, profile: body.profile };
  }
  if (body?.type === "charge-limit" && typeof body.enabled === "boolean") {
    return { type: body.type, enabled: body.enabled };
  }
  return null;
}

if (require.main === module) {
  const configuredOrigins = (process.env.NORTHSTAR_ALLOWED_ORIGINS || "https://jdj212223-ctrl.github.io")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const remote = createRemoteServer({
    allowedOrigins: configuredOrigins,
    trustProxy: process.env.NORTHSTAR_TRUST_PROXY === "1"
  });
  const port = Number.parseInt(process.env.PORT || process.env.NORTHSTAR_API_PORT || "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  remote.server.listen(port, process.env.HOST || "0.0.0.0", () => {
    console.log(`Northstar remote service listening on port ${port}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void remote.close().then(() => process.exit(0));
    });
  }
}

module.exports = { createRemoteServer, validateCommand, boundedTelemetry };
