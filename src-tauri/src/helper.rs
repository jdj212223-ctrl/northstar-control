use crate::util::*;
use serde_json::json;
use std::path::PathBuf;

pub fn executable() -> Option<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/smctl"),
        PathBuf::from("/usr/local/bin/smctl"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".linuxbrew/bin/smctl"));
    }
    candidates.into_iter().find(|path| path.exists())
}

fn unavailable() -> Json {
    json!({
        "installed": false, "daemonAvailable": false, "fanAvailable": false,
        "chargeLimitAvailable": false, "fanRpm": null, "chargeLimit": null
    })
}

pub fn fan_profile_arg(profile: &str) -> Option<&'static str> {
    match profile {
        "Auto" => Some("auto"),
        "Quiet" => Some("quiet"),
        _ => None,
    }
}

fn rounded(value: Option<&Json>) -> Option<i64> {
    value.and_then(|item| item.as_f64()).map(|number| number.round() as i64)
}

pub async fn get_status() -> Json {
    if !is_mac() {
        return unavailable();
    }
    let Some(exe) = executable() else { return unavailable() };
    let exe = exe.to_string_lossy().into_owned();
    let (fan_result, battery_result) = tokio::join!(
        run(&exe, &["fan", "status", "--json"], 5000),
        run(&exe, &["battery", "status", "--json"], 5000)
    );
    let fan_json = fan_result.as_ref().ok().and_then(|text| parse_json(text));
    let battery = battery_result.as_ref().ok().and_then(|text| parse_json(text));
    let fans = fan_json
        .as_ref()
        .and_then(|value| value["fans"].as_array().cloned())
        .unwrap_or_default();
    let fan = fans.iter().find(|item| item["actualRPM"].is_number());
    let charge_limit = battery
        .as_ref()
        .and_then(|value| value["configuredLimit"].as_str())
        .and_then(|text| text.parse::<u32>().ok());
    let minimum = rounded(fan.map(|item| &item["minimumRPM"]));
    let actual = rounded(fan.map(|item| &item["actualRPM"]));
    json!({
        "installed": true,
        "daemonAvailable": fan_result.is_ok() || battery_result.is_ok(),
        "fanAvailable": !fans.is_empty(),
        "fanProfile": fan_json.as_ref().and_then(|value| value["profile"].as_str()),
        "fanMode": fan.and_then(|item| item["mode"].as_str()),
        "fanMinimumRpm": minimum,
        "fanMaximumRpm": rounded(fan.map(|item| &item["maximumRPM"])),
        "fanAtReportedMinimum": match (minimum, actual) { (Some(a), Some(b)) => (a - b).abs() <= 2, _ => false },
        "chargeLimitAvailable": battery.as_ref().map(|value| value["chargingControlSupported"] == true).unwrap_or(false),
        "fanRpm": actual,
        "chargeLimit": charge_limit
    })
}

pub struct Sensors {
    pub temperature_c: Option<i64>,
    pub package_power_w: Option<f64>,
    pub system_power_w: Option<f64>,
    pub thermal_pressure: Option<String>,
}

fn two_places(value: Option<f64>) -> Option<f64> {
    value
        .filter(|number| number.is_finite())
        .map(|number| (number * 100.0).round() / 100.0)
}

pub async fn get_sensors() -> Option<Sensors> {
    if !is_mac() {
        return None;
    }
    let exe = executable()?.to_string_lossy().into_owned();
    let (sensors, power) = tokio::join!(
        run(&exe, &["sensors", "--json"], 5000),
        run(&exe, &["power", "status", "--json"], 5000)
    );
    let sensors = sensors.ok().and_then(|text| parse_json(&text));
    let power = power.ok().and_then(|text| parse_json(&text));
    let hottest = sensors
        .as_ref()
        .and_then(|value| value["temperatures"].as_array())
        .and_then(|items| {
            items
                .iter()
                .filter(|item| matches!(item["group"].as_str(), Some("Tp") | Some("Tg")))
                .filter_map(|item| item["celsius"].as_f64())
                .filter(|celsius| *celsius > 0.0 && *celsius < 130.0)
                .fold(None, |best: Option<f64>, value| Some(best.map_or(value, |current| current.max(value))))
        });
    Some(Sensors {
        temperature_c: hottest.map(|value| value.round() as i64),
        package_power_w: two_places(power.as_ref().and_then(|value| value["packagePowerWatts"].as_f64())),
        system_power_w: two_places(power.as_ref().and_then(|value| value["systemPowerWatts"].as_f64())),
        thermal_pressure: power
            .as_ref()
            .and_then(|value| value["thermalPressure"].as_str())
            .map(str::to_string),
    })
}

pub async fn set_fan_profile(profile: &str) -> Json {
    let Some(arg) = fan_profile_arg(profile) else {
        return json!({"ok": false, "reason": "invalid-profile"});
    };
    let Some(exe) = executable() else {
        return json!({"ok": false, "reason": "helper-not-installed"});
    };
    match run(&exe.to_string_lossy(), &["fan", "profile", arg], 5000).await {
        Ok(_) => json!({"ok": true, "profile": profile}),
        Err(_) => json!({"ok": false, "reason": "helper-or-hardware-unavailable"}),
    }
}

pub async fn set_charge_limit(enabled: bool) -> Json {
    let Some(exe) = executable() else {
        return json!({"ok": false, "reason": "helper-not-installed"});
    };
    let arg = if enabled { "80" } else { "stop" };
    match run(&exe.to_string_lossy(), &["battery", "maintain", arg], 5000).await {
        Ok(_) => json!({"ok": true, "enabled": enabled, "chargeLimit": if enabled { json!(80) } else { Json::Null }}),
        Err(_) => json!({"ok": false, "reason": "helper-or-hardware-unavailable"}),
    }
}

pub fn access_message(status: &Json) -> (String, String) {
    let installed = status["installed"] == true;
    if installed && status["daemonAvailable"] == true {
        let fan = if status["fanAvailable"] == true {
            "Fan telemetry is available."
        } else {
            "This Mac did not report a controllable fan."
        };
        let battery = if status["chargeLimitAvailable"] == true {
            "Battery charge control is available."
        } else {
            "This Mac did not report battery charge-limit support."
        };
        return (
            "The macOS hardware helper is installed and running.".into(),
            format!("{fan} {battery} USB port power is not supported."),
        );
    }
    if installed {
        return (
            "The smctl command is installed, but its helper is not responding.".into(),
            "Authorize or restart the helper from Terminal with `sudo smctl daemon install`. Northstar does not run privileged installers for you.".into(),
        );
    }
    (
        "The optional macOS hardware helper is not installed.".into(),
        "For supported Apple Silicon Macs, download the signed smctl release from https://github.com/leaperone/smctl/releases and install its smctl and smctld binaries. Then run `sudo smctl daemon install` in Terminal. The Homebrew formula builds from source and requires the full Xcode app. USB port power is not supported.".into(),
    )
}
