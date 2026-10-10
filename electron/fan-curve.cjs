"use strict";

const DEFAULTS = Object.freeze({
  quietBelowC: 68,
  autoAboveC: 78,
  emergencyC: 90,
  minHoldMs: 90 * 1000
});

// Chooses "Quiet" only while the machine is comfortably cool, and hands control back
// to the system ("Auto") as it warms up. The gap between the two thresholds plus a
// minimum hold time stops the profile from flapping, which is what makes fans ramp.
function decideFanProfile({ tempC, current, lastChangeAt = 0, now = Date.now(), options = {} }) {
  const config = { ...DEFAULTS, ...options };
  if (!Number.isFinite(tempC)) return { profile: "Auto", changed: current !== "Auto", reason: "no-temperature" };
  if (tempC >= config.emergencyC) return { profile: "Auto", changed: current !== "Auto", reason: "emergency" };
  const held = now - lastChangeAt < config.minHoldMs;
  if (current === "Quiet") {
    if (tempC >= config.autoAboveC && !held) return { profile: "Auto", changed: true, reason: "warming" };
    return { profile: "Quiet", changed: false, reason: "holding" };
  }
  if (tempC <= config.quietBelowC && !held) return { profile: "Quiet", changed: true, reason: "cool" };
  return { profile: "Auto", changed: false, reason: "holding" };
}

module.exports = { decideFanProfile, DEFAULTS };
