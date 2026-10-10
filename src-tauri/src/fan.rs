use crate::helper;
use crate::util::*;
use serde_json::json;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

pub const QUIET_BELOW_C: f64 = 68.0;
pub const AUTO_ABOVE_C: f64 = 78.0;
pub const EMERGENCY_C: f64 = 90.0;
pub const MIN_HOLD_MS: u64 = 90_000;

pub struct Decision {
    pub profile: &'static str,
    pub changed: bool,
    pub reason: &'static str,
}

// Quiet only while comfortably cool; the gap between thresholds plus a minimum hold stops flapping.
pub fn decide(temp_c: Option<f64>, current: &str, last_change_ms: u64, now_ms: u64) -> Decision {
    let Some(temp) = temp_c.filter(|value| value.is_finite()) else {
        return Decision { profile: "Auto", changed: current != "Auto", reason: "no-temperature" };
    };
    if temp >= EMERGENCY_C {
        return Decision { profile: "Auto", changed: current != "Auto", reason: "emergency" };
    }
    let held = now_ms.saturating_sub(last_change_ms) < MIN_HOLD_MS;
    if current == "Quiet" {
        if temp >= AUTO_ABOVE_C && !held {
            return Decision { profile: "Auto", changed: true, reason: "warming" };
        }
        return Decision { profile: "Quiet", changed: false, reason: "holding" };
    }
    if temp <= QUIET_BELOW_C && !held {
        return Decision { profile: "Quiet", changed: true, reason: "cool" };
    }
    Decision { profile: "Auto", changed: false, reason: "holding" }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

struct Inner {
    enabled: bool,
    current: String,
    last_change_ms: u64,
    reason: String,
    task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Clone)]
pub struct SmartFan(Arc<Mutex<Inner>>);

impl SmartFan {
    pub fn new() -> Self {
        SmartFan(Arc::new(Mutex::new(Inner {
            enabled: false,
            current: "Auto".into(),
            last_change_ms: 0,
            reason: "off".into(),
            task: None,
        })))
    }

    pub async fn state(&self) -> Json {
        let inner = self.0.lock().await;
        json!({"enabled": inner.enabled, "current": inner.current, "reason": inner.reason, "supported": is_mac()})
    }

    async fn tick(&self) {
        let (status, sensors) = tokio::join!(helper::get_status(), helper::get_sensors());
        let decision = {
            let mut inner = self.0.lock().await;
            if status["fanAvailable"] != true || status["daemonAvailable"] != true {
                inner.reason = "fan-unavailable".into();
                return;
            }
            if let Some(profile) = status["fanProfile"].as_str() {
                inner.current = if profile.eq_ignore_ascii_case("quiet") { "Quiet".into() } else { "Auto".into() };
            }
            let temp = sensors.and_then(|item| item.temperature_c).map(|value| value as f64);
            let decision = decide(temp, &inner.current, inner.last_change_ms, now_ms());
            inner.reason = decision.reason.into();
            decision
        };
        if decision.changed && helper::set_fan_profile(decision.profile).await["ok"] == true {
            let mut inner = self.0.lock().await;
            inner.current = decision.profile.into();
            inner.last_change_ms = now_ms();
        }
    }

    pub async fn set(&self, enabled: bool, confirm: ConfirmFn) -> Json {
        if !is_mac() {
            return json!({"ok": false, "reason": "unsupported"});
        }
        if self.0.lock().await.enabled == enabled {
            return json!({"ok": true, "enabled": enabled});
        }
        if enabled {
            let status = helper::get_status().await;
            if status["fanAvailable"] != true {
                let reason = if status["installed"] == true {
                    "helper-or-hardware-unavailable"
                } else {
                    "helper-not-installed"
                };
                return json!({"ok": false, "reason": reason});
            }
            let approved = confirm(ConfirmRequest {
                title: "Confirm hardware change".into(),
                message: "Turn on smart cooling?".into(),
                detail: "Northstar will switch between Quiet and Automatic fan control based on temperature. It returns to Automatic when turned off, when the Mac gets hot, or when the app quits.".into(),
                ok_label: "Apply".into(),
            })
            .await;
            if !approved {
                return json!({"ok": false, "reason": "cancelled"});
            }
            {
                let mut inner = self.0.lock().await;
                inner.enabled = true;
                inner.reason = "starting".into();
            }
            self.tick().await;
            let runner = self.clone();
            let handle = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                    runner.tick().await;
                }
            });
            self.0.lock().await.task = Some(handle);
        } else {
            self.stop().await;
        }
        let now_enabled = self.0.lock().await.enabled;
        json!({"ok": true, "enabled": now_enabled})
    }

    pub async fn stop(&self) {
        let (was_enabled, needs_restore) = {
            let mut inner = self.0.lock().await;
            if let Some(task) = inner.task.take() {
                task.abort();
            }
            let was = inner.enabled;
            inner.enabled = false;
            inner.reason = "off".into();
            (was, inner.current != "Auto")
        };
        if was_enabled && needs_restore {
            let _ = helper::set_fan_profile("Auto").await;
            self.0.lock().await.current = "Auto".into();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_auto_while_warm() {
        let d = decide(Some(72.0), "Auto", 0, 1_000_000);
        assert_eq!((d.profile, d.changed), ("Auto", false));
    }

    #[test]
    fn goes_quiet_when_cool_and_back_when_hot() {
        assert_eq!(decide(Some(60.0), "Auto", 0, 1_000_000).profile, "Quiet");
        assert_eq!(decide(Some(80.0), "Quiet", 0, 1_000_000).profile, "Auto");
    }

    #[test]
    fn holds_and_emergency() {
        assert!(!decide(Some(60.0), "Auto", 1_000_000, 1_010_000).changed);
        assert!(decide(Some(95.0), "Quiet", 1_000_000, 1_001_000).changed);
        assert_eq!(decide(None, "Quiet", 0, 0).profile, "Auto");
    }
}
