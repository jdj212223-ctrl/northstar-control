use crate::util::*;
use rand::RngCore;
use serde_json::json;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use sysinfo::{Disks, System};

pub const CPU_ITERATIONS: u64 = 60_000_000;
const MIB: usize = 1024 * 1024;
pub const DISK_SIZES_MB: [u64; 3] = [64, 256, 1024];

// Fixed amount of mixed integer and floating-point work, so results are comparable run to run.
pub fn kernel(iterations: u64) -> f64 {
    let mut a: u32 = 0x9e37_79b9;
    let mut x: f64 = 1.000001;
    let mut sum: f64 = 0.0;
    for i in 0..iterations {
        a = (a ^ (a >> 15)).wrapping_mul(0x2c1b_3c6d);
        a ^= a >> 12;
        x = x * 1.0000001 + ((i as f64) * 0.001).sin() * 0.0000001;
        sum += f64::from(a & 0xff) + x;
    }
    std::hint::black_box(sum)
}

fn time_kernel(iterations: u64) -> f64 {
    let start = Instant::now();
    kernel(iterations);
    start.elapsed().as_secs_f64() * 1000.0
}

pub fn bench_cpu() -> Json {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let single_ms = time_kernel(CPU_ITERATIONS);
    let handles: Vec<_> = (0..threads)
        .map(|_| std::thread::spawn(|| time_kernel(CPU_ITERATIONS)))
        .collect();
    let multi_ms = handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .fold(0.0_f64, f64::max)
        .max(0.001);
    // Millions of iterations per second.
    let single = CPU_ITERATIONS as f64 / single_ms / 1000.0;
    let multi = (CPU_ITERATIONS * threads as u64) as f64 / multi_ms / 1000.0;
    let mut system = System::new();
    system.refresh_cpu_usage();
    let model = system
        .cpus()
        .first()
        .map(|cpu| cpu.brand().trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "Unknown CPU".into());
    json!({
        "model": model,
        "threads": threads,
        "singleScore": (single * 10.0).round() as i64,
        "multiScore": (multi * 10.0).round() as i64,
        "scaling": ((multi / single) * 100.0).round() / 100.0
    })
}

pub fn bench_memory() -> Json {
    let size = 64 * MIB;
    let source = vec![0x5a_u8; size];
    let mut target = vec![0_u8; size];
    target.copy_from_slice(&source);
    let rounds = 12;
    let start = Instant::now();
    for _ in 0..rounds {
        target.copy_from_slice(std::hint::black_box(&source));
        std::hint::black_box(&mut target);
    }
    let seconds = start.elapsed().as_secs_f64().max(1e-9);
    let mut system = System::new();
    system.refresh_memory();
    json!({
        "copyGBps": (((size * rounds) as f64 / seconds / 1e9) * 100.0).round() / 100.0,
        "totalGB": ((system.total_memory() as f64 / 1e9) * 10.0).round() / 10.0
    })
}

fn free_bytes(directory: &Path) -> Option<u64> {
    let canonical = directory.canonicalize().ok()?;
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
}

pub fn bench_disk(directory: &Path, size_mb: u64, cancel: &AtomicBool, progress: &dyn Fn(u32)) -> Result<Json, String> {
    if !DISK_SIZES_MB.contains(&size_mb) {
        return Err("Unsupported test size.".into());
    }
    if !directory.is_dir() {
        return Err("Target is not a folder.".into());
    }
    if let Some(free) = free_bytes(directory) {
        if free < (size_mb + 64) * MIB as u64 {
            return Err("Not enough free space for this test size.".into());
        }
    }
    let mut suffix = [0_u8; 6];
    rand::thread_rng().fill_bytes(&mut suffix);
    let file = directory.join(format!(".northstar-bench-{}.tmp", hex::encode(suffix)));
    let result = run_disk(&file, size_mb, cancel, progress);
    let _ = std::fs::remove_file(&file);
    result
}

fn run_disk(file: &Path, size_mb: u64, cancel: &AtomicBool, progress: &dyn Fn(u32)) -> Result<Json, String> {
    let mut chunk = vec![0_u8; 4 * MIB];
    rand::thread_rng().fill_bytes(&mut chunk);
    let chunks = (size_mb as usize * MIB) / chunk.len();

    let mut handle = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(file)
        .map_err(|error| error.to_string())?;
    let write_start = Instant::now();
    for index in 0..chunks {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled.".into());
        }
        handle.write_all(&chunk).map_err(|error| error.to_string())?;
        if index % 4 == 0 {
            progress(((index * 50) / chunks) as u32);
        }
    }
    handle.sync_all().map_err(|error| error.to_string())?;
    let write_seconds = write_start.elapsed().as_secs_f64().max(1e-9);
    drop(handle);

    let mut reader = std::fs::File::open(file).map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; chunk.len()];
    let read_start = Instant::now();
    for index in 0..chunks {
        if cancel.load(Ordering::Relaxed) {
            return Err("Cancelled.".into());
        }
        reader
            .seek(SeekFrom::Start((index * buffer.len()) as u64))
            .map_err(|error| error.to_string())?;
        reader.read_exact(&mut buffer).map_err(|error| error.to_string())?;
        if index % 4 == 0 {
            progress(50 + ((index * 50) / chunks) as u32);
        }
    }
    let read_seconds = read_start.elapsed().as_secs_f64().max(1e-9);
    Ok(json!({
        "sizeMb": size_mb,
        "writeMBps": (size_mb as f64 / write_seconds).round() as i64,
        "readMBps": (size_mb as f64 / read_seconds).round() as i64,
        // The OS may serve part of the read from its cache, so read speed can be optimistic.
        "readMayBeCached": true
    }))
}

fn home_dir() -> PathBuf {
    std::env::var(if is_windows() { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
}

fn user_name() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

pub async fn list_volumes() -> Vec<Json> {
    let home = home_dir();
    let mut volumes = vec![json!({
        "id": "home", "label": "This computer (home folder)",
        "path": home.to_string_lossy(), "external": false
    })];
    if is_mac() {
        if let Ok(entries) = std::fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let full = entry.path();
                if std::fs::canonicalize(&full).map(|real| real == Path::new("/")).unwrap_or(true) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                volumes.push(json!({"id": full.to_string_lossy(), "label": name, "path": full.to_string_lossy(), "external": true}));
            }
        }
    } else if is_windows() {
        let mut removable: Vec<String> = vec![];
        let script = "Get-Volume | Where-Object DriveType -eq 'Removable' | ForEach-Object { $_.DriveLetter }";
        if let Ok(text) = run(&windows_powershell(), &["-NoProfile", "-Command", script], 6000).await {
            removable = text.split_whitespace().map(|letter| letter.to_uppercase()).collect();
        }
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ".chars() {
            let root = format!("{letter}:\\");
            if Path::new(&root).exists() {
                let is_removable = removable.contains(&letter.to_string());
                let suffix = if is_removable { " (USB / removable)" } else { "" };
                volumes.push(json!({"id": root, "label": format!("Drive {letter}:{suffix}"), "path": root, "external": is_removable}));
            }
        }
    } else {
        let user = user_name();
        for (base, external) in [
            (format!("/run/media/{user}"), true),
            (format!("/media/{user}"), true),
            ("/mnt".to_string(), false),
        ] {
            let Ok(entries) = std::fs::read_dir(&base) else { continue };
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let full = entry.path();
                    volumes.push(json!({"id": full.to_string_lossy(), "label": name, "path": full.to_string_lossy(), "external": external}));
                }
            }
        }
    }
    volumes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_is_deterministic() {
        assert_eq!(kernel(10_000), kernel(10_000));
    }

    #[test]
    fn rejects_unsupported_sizes() {
        let cancel = AtomicBool::new(false);
        assert!(bench_disk(&std::env::temp_dir(), 7, &cancel, &|_| {}).is_err());
    }

    #[test]
    fn disk_bench_cleans_up_its_file() {
        let dir = std::env::temp_dir().join(format!("ns-bench-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cancel = AtomicBool::new(false);
        let result = bench_disk(&dir, 64, &cancel, &|_| {});
        assert!(result.is_ok());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
