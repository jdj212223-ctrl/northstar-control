"use strict";

const RELEASE_API = "https://api.github.com/repos/jdj212223-ctrl/northstar-control/releases/latest";
const RELEASE_PREFIX = "https://github.com/jdj212223-ctrl/northstar-control/releases/";

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(value || "").trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || "" };
}

function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  }
  return !a.pre && Boolean(b.pre);
}

function parseRelease(release, currentVersion) {
  if (!release || typeof release !== "object" || release.draft || release.prerelease) return { available: false };
  const version = String(release.tag_name || "").replace(/^v/, "");
  if (!isNewerVersion(version, currentVersion)) return { available: false };
  const url = String(release.html_url || "");
  if (!url.startsWith(RELEASE_PREFIX)) return { available: false };
  const assets = (Array.isArray(release.assets) ? release.assets : [])
    .filter((asset) => asset && typeof asset.name === "string" && typeof asset.browser_download_url === "string")
    .map((asset) => ({ name: asset.name, url: asset.browser_download_url, digest: String(asset.digest || ""), size: Number(asset.size) || 0 }));
  return { available: true, version, url, assets };
}

function createUpdater({ currentVersion, fetchImpl = globalThis.fetch, onChange = () => {}, intervalMs = 6 * 60 * 60 * 1000 }) {
  let state = { available: false, checking: false, currentVersion, version: null, url: null, assets: [], error: null };
  let timer = null;

  async function check() {
    state = { ...state, checking: true, error: null };
    try {
      const response = await fetchImpl(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Northstar-Control" },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const result = parseRelease(await response.json(), currentVersion);
      state = { ...state, checking: false, available: result.available, version: result.version || null, url: result.url || null, assets: result.assets || [] };
    } catch (error) {
      state = { ...state, checking: false, error: error.message };
    }
    onChange(state);
    return state;
  }

  return {
    check,
    getState: () => state,
    start() {
      check();
      timer = setInterval(check, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); }
  };
}

module.exports = { createUpdater, isNewerVersion, parseRelease, RELEASE_PREFIX };
