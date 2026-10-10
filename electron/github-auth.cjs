"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const DEVICE_ENDPOINT = "https://github.com/login/device/code";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const PROFILE_ENDPOINT = "https://api.github.com/user";
const VERIFICATION_URI = "https://github.com/login/device";
const API_VERSION = "2022-11-28";

function createGitHubAuth({ safeStorage, storagePath, fetchImpl = globalThis.fetch, now = Date.now, defaultClientId = "" }) {
  let pendingFlow = null;
  let clientId = CLIENT_ID_PATTERN.test(defaultClientId) ? defaultClientId : "";
  let storedProfile = null;
  let storedAccessToken = null;
  let initialization;
  const isSecureStorageAvailable = () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform !== "linux") return true;
    if (typeof safeStorage.getSelectedStorageBackend !== "function") return false;
    return !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend());
  };

  function initialize() {
    if (!initialization) {
      initialization = (async () => {
        try {
          const config = JSON.parse(await fs.readFile(storagePath, "utf8"));
          if (typeof config.clientId === "string" && CLIENT_ID_PATTERN.test(config.clientId)) clientId = config.clientId;
          if (typeof config.encryptedAccount === "string" && isSecureStorageAvailable()) {
            const saved = JSON.parse(safeStorage.decryptString(Buffer.from(config.encryptedAccount, "base64")));
            if (typeof saved.accessToken === "string" && saved.profile && typeof saved.profile.login === "string") {
              storedAccessToken = saved.accessToken;
              storedProfile = saved.profile;
            }
          }
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
      })();
    }
    return initialization;
  }

  async function persist() {
    await fs.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
    const config = { clientId };
    if (storedProfile && storedAccessToken) {
      if (!isSecureStorageAvailable()) throw new Error("Secure credential storage is unavailable");
      const encryptedAccount = safeStorage.encryptString(JSON.stringify({
        accessToken: storedAccessToken,
        profile: storedProfile
      }));
      config.encryptedAccount = encryptedAccount.toString("base64");
    }
    const temporaryPath = `${storagePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, storagePath);
  }

  async function saveClientId(value) {
    await initialize();
    if (typeof value !== "string" || !CLIENT_ID_PATTERN.test(value.trim())) {
      return { ok: false, reason: "invalid-client-id" };
    }
    const nextClientId = value.trim();
    if (nextClientId !== clientId) {
      storedAccessToken = null;
      storedProfile = null;
    }
    clientId = nextClientId;
    pendingFlow = null;
    await persist();
    return { ok: true, configured: true };
  }

  async function getStatus() {
    await initialize();
    return {
      configured: Boolean(clientId),
      secureStorageAvailable: isSecureStorageAvailable(),
      clientId,
      account: storedProfile ? { ...storedProfile } : null
    };
  }

  async function begin() {
    await initialize();
    if (!clientId) return { ok: false, reason: "client-id-required" };
    if (!isSecureStorageAvailable()) return { ok: false, reason: "secure-storage-unavailable" };
    const response = await fetchImpl(DEVICE_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Northstar-Control" },
      body: JSON.stringify({ client_id: clientId, scope: "read:user" }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    if (!response.ok || data.error || typeof data.device_code !== "string" || typeof data.user_code !== "string" || typeof data.verification_uri !== "string") {
      return { ok: false, reason: "github-device-request-failed" };
    }
    let verificationUrl;
    try {
      verificationUrl = new URL(data.verification_uri);
    } catch {
      return { ok: false, reason: "github-invalid-verification-url" };
    }
    if (verificationUrl.protocol !== "https:" || verificationUrl.hostname !== "github.com" || verificationUrl.pathname !== "/login/device") {
      return { ok: false, reason: "github-invalid-verification-url" };
    }
    const expiresIn = Number(data.expires_in);
    const interval = Number(data.interval);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 3600 || !Number.isFinite(interval) || interval < 1 || interval > 300) {
      return { ok: false, reason: "github-invalid-device-response" };
    }
    pendingFlow = {
      deviceCode: data.device_code,
      expiresAt: now() + expiresIn * 1000,
      interval: Math.floor(interval),
      nextPollAt: 0
    };
    return {
      ok: true,
      userCode: data.user_code,
      verificationUrl: verificationUrl.href,
      expiresIn,
      interval: pendingFlow.interval
    };
  }

  async function poll() {
    await initialize();
    if (!pendingFlow) return { status: "not-started" };
    if (now() >= pendingFlow.expiresAt) {
      pendingFlow = null;
      return { status: "expired" };
    }
    if (now() < pendingFlow.nextPollAt) {
      return { status: "pending", retryAfterMs: pendingFlow.nextPollAt - now() };
    }
    pendingFlow.nextPollAt = now() + pendingFlow.interval * 1000;
    const currentFlow = pendingFlow;
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Northstar-Control" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: currentFlow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    if (pendingFlow !== currentFlow) return { status: "cancelled" };
    if (data.error === "authorization_pending") {
      return { status: "pending", retryAfterMs: pendingFlow.interval * 1000 };
    }
    if (data.error === "slow_down") {
      pendingFlow.interval = Math.min(pendingFlow.interval + 5, 60);
      return { status: "pending", retryAfterMs: pendingFlow.interval * 1000 };
    }
    if (data.error === "access_denied") {
      pendingFlow = null;
      return { status: "denied" };
    }
    if (data.error === "expired_token") {
      pendingFlow = null;
      return { status: "expired" };
    }
    if (!response.ok || typeof data.access_token !== "string") {
      pendingFlow = null;
      return { status: "failed" };
    }
    const accountResponse = await fetchImpl(PROFILE_ENDPOINT, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${data.access_token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "Northstar-Control"
      },
      signal: AbortSignal.timeout(10000)
    });
    const account = await accountResponse.json();
    if (pendingFlow !== currentFlow) return { status: "cancelled" };
    if (!accountResponse.ok || typeof account.login !== "string" || typeof account.avatar_url !== "string" || typeof account.html_url !== "string") {
      pendingFlow = null;
      return { status: "profile-failed" };
    }
    storedProfile = {
      login: account.login,
      name: typeof account.name === "string" && account.name.trim() ? account.name : account.login,
      avatarUrl: account.avatar_url,
      profileUrl: account.html_url
    };
    storedAccessToken = data.access_token;
    await persist();
    pendingFlow = null;
    return { status: "authorized", account: { ...storedProfile } };
  }

  function cancel() {
    pendingFlow = null;
    return { ok: true };
  }

  async function signOut() {
    await initialize();
    storedAccessToken = null;
    storedProfile = null;
    pendingFlow = null;
    await persist();
    return { ok: true };
  }

  return Object.freeze({ begin, cancel, getStatus, poll, saveClientId, signOut });
}

module.exports = { createGitHubAuth };
