use crate::util::Json;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

const CONFIG_FILE: &str = "lockdown.json";
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Load the saved state so isolation survives a restart.
pub fn init() {
    let saved = crate::store::read_config(CONFIG_FILE).map(|value| value["active"] == true).unwrap_or(false);
    ACTIVE.store(saved, Ordering::SeqCst);
}

pub fn active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

pub fn set(value: bool) {
    ACTIVE.store(value, Ordering::SeqCst);
    let _ = crate::store::write_config(CONFIG_FILE, &json!({"active": value}));
}

pub fn status() -> Json {
    json!({"active": active()})
}

pub fn blocked() -> Json {
    json!({"ok": false, "reason": "isolated", "message": "Northstar is isolated. Turn Isolate off to reconnect."})
}

#[cfg(test)]
mod tests {
    #[test]
    fn toggles() {
        super::ACTIVE.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(super::active());
        super::ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(!super::active());
        assert_eq!(super::blocked()["reason"], "isolated");
    }
}
