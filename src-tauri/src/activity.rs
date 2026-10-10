use crate::util::Json;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};

static SYSTEM: OnceLock<Mutex<(System, bool)>> = OnceLock::new();

struct Group {
    name: String,
    command: String,
    cpu: f64,
    memory: u64,
    count: u64,
}

fn sample() -> Json {
    let cell = SYSTEM.get_or_init(|| Mutex::new((System::new(), false)));
    let mut guard = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (system, primed) = &mut *guard;
    if !*primed {
        system.refresh_processes(ProcessesToUpdate::All, true);
        std::thread::sleep(Duration::from_millis(400));
        *primed = true;
    }
    system.refresh_processes(ProcessesToUpdate::All, true);

    let ps = crate::util::ps_cpu_map();
    let mut groups: HashMap<String, Group> = HashMap::new();
    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy().into_owned();
        // Only the executable path is reported; command-line arguments can contain secrets.
        let command = process
            .exe()
            .map(|path| path.to_string_lossy().into_owned())
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| name.clone());
        let group = groups.entry(command.to_lowercase()).or_insert_with(|| Group {
            name: name.clone(),
            command: command.clone(),
            cpu: 0.0,
            memory: 0,
            count: 0,
        });
        let cpu = ps.as_ref().and_then(|map| map.get(&pid.as_u32()).copied()).unwrap_or_else(|| process.cpu_usage());
        group.cpu += cpu as f64;
        group.memory += process.memory();
        group.count += 1;
    }
    let mut list: Vec<Group> = groups.into_values().collect();
    list.sort_by(|left, right| right.cpu.partial_cmp(&left.cpu).unwrap_or(std::cmp::Ordering::Equal));
    let processes: Vec<Json> = list
        .into_iter()
        .map(|group| {
            json!({
                "name": group.name,
                "command": group.command,
                "cpuPercent": (group.cpu * 10.0).round() / 10.0,
                "memoryBytes": group.memory,
                "processCount": group.count
            })
        })
        .collect();
    json!({"processes": processes, "capturedAt": chrono_like_now()})
}

fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub async fn get_process_activity() -> Result<Json, String> {
    tokio::task::spawn_blocking(sample).await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {

    #[test]
    fn timestamp_has_iso_shape() {
        let text = super::chrono_like_now();
        assert_eq!(text.len(), 24);
        assert!(text.ends_with('Z') && text.contains('T'));
    }
}
