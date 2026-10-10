(() => {
  "use strict";
  const api = window.northstar;
  const list = document.getElementById("ssd-list");
  if (!api || !api.ssd || !list) return;

  const make = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const fmt = (value, digits = 0) => (value === null || value === undefined ? "—" : Number(value).toFixed(digits));

  function stat(label, value, unit) {
    const box = make("div", "bench-stat");
    box.append(make("span", "", label));
    const strong = make("strong", "", value);
    if (unit) strong.append(make("small", "", ` ${unit}`));
    box.append(strong);
    return box;
  }

  function card(drive) {
    const panel = make("article", "panel ssd-card");
    const head = make("div", "panel-heading");
    const title = make("div");
    title.append(make("h2", "", drive.model), make("p", "", `${fmt(drive.capacityGB)} GB · ${fmt(drive.powerOnHours)} power-on hours${drive.temperatureC != null ? ` · ${fmt(drive.temperatureC)}°C` : ""}`));
    const badge = make("span", `ssd-badge ssd-${String(drive.status).toLowerCase().replace(/\s+/g, "-")}`, drive.status);
    head.append(title, badge);

    const gauge = make("div", "ssd-gauge");
    const score = make("div", "ssd-score");
    score.append(make("strong", "", drive.healthPercent == null ? "—" : `${fmt(drive.healthPercent)}%`), make("span", "", "HEALTH"));
    const track = make("div", "ssd-track");
    const fill = make("i");
    fill.style.width = `${Math.max(0, Math.min(100, drive.healthPercent ?? 0))}%`;
    track.append(fill);
    gauge.append(score, track);

    const stats = make("div", "bench-result");
    stats.append(
      stat("Total written", fmt(drive.writtenTB, 1), "TB"),
      stat("Rated endurance", drive.ratedTBW == null ? "—" : fmt(drive.ratedTBW), "TBW (est.)"),
      stat("Wear", drive.driveWearPercent == null ? "—" : fmt(drive.driveWearPercent), "%"),
      stat("Est. years left", drive.yearsLeft == null ? "—" : fmt(drive.yearsLeft, 1), "yr")
    );
    const extra = [];
    if (drive.availableSparePercent != null) extra.push(`Spare blocks ${fmt(drive.availableSparePercent)}%`);
    if (drive.mediaErrors != null) extra.push(`Media errors ${fmt(drive.mediaErrors)}`);
    if (drive.estimatedHealthPercent != null && drive.healthSource === "drive") extra.push(`Write-based estimate ${fmt(drive.estimatedHealthPercent)}%`);

    const source = drive.healthSource === "drive"
      ? "Health comes from the drive's own wear indicator (100% − wear)."
      : drive.healthSource === "estimate"
        ? "This drive doesn't report wear, so health is estimated: bytes written compared with a typical ~600 TBW per TB of capacity. Your drive's real rating may differ."
        : "Not enough data to score this drive.";
    panel.append(head, gauge, stats, make("p", "fine-print", [...extra, source].join(" · ")));
    return panel;
  }

  const reasons = {
    "smartctl-missing": "Drive health needs the free smartmontools package. Install it (macOS: brew install smartmontools · Windows: smartmontools.org · Linux: your package manager), then re-read.",
    "permission-or-unsupported": "Could not read SMART data. On Linux this usually needs permission: run the app with access to the drive, or install smartmontools.",
    unsupported: "No readable SSD was found on this system."
  };

  async function load() {
    list.replaceChildren(make("div", "panel bench-empty", "Reading drives…"));
    try {
      const result = await api.ssd.health();
      if (!result.ok) {
        list.replaceChildren(make("div", "panel bench-empty", reasons[result.reason] || "Drive health is unavailable."));
        return;
      }
      list.replaceChildren(...result.drives.map(card));
    } catch {
      list.replaceChildren(make("div", "panel bench-empty", "Drive health is unavailable."));
    }
  }

  document.getElementById("ssd-refresh").addEventListener("click", load);
  document.querySelector('.nav-item[data-view="ssd"]').addEventListener("click", load);
})();
