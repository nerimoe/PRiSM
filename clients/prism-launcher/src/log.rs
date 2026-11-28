//! Rotating file + Windows debug output logger, matching `hinata-io`'s logging style.
use log::LevelFilter;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_LOG_BYTES: u64 = 256 * 1024;
const BACKUP_COUNT: usize = 2;

struct RotatingWriter {
    path: PathBuf,
    lock: Mutex<()>,
}

impl RotatingWriter {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn rotate_if_needed(&self) {
        let Ok(meta) = fs::metadata(&self.path) else {
            return;
        };
        if meta.len() < MAX_LOG_BYTES {
            return;
        }
        for i in (1..=BACKUP_COUNT).rev() {
            let dst = backup_path(&self.path, i);
            if i == BACKUP_COUNT {
                let _ = fs::remove_file(&dst);
            }
            let src = if i == 1 {
                self.path.clone()
            } else {
                backup_path(&self.path, i - 1)
            };
            if src.exists() {
                let _ = fs::rename(src, dst);
            }
        }
    }

    fn append(&self, bytes: &[u8]) {
        let _guard = self.lock.lock().ok();
        self.rotate_if_needed();
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = file.write_all(bytes);
            let _ = file.flush();
        }
    }
}

fn backup_path(base: &Path, index: usize) -> PathBuf {
    let mut name = base.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

impl Write for RotatingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        #[cfg(windows)]
        {
            use windows::Win32::System::Diagnostics::Debug::OutputDebugStringW;
            use windows::Win32::System::SystemInformation::GetLocalTime;
            use windows::core::PCWSTR;

            let text = String::from_utf8_lossy(buf);
            let mut wide: Vec<u16> = text.encode_utf16().collect();
            wide.push(0);
            unsafe { OutputDebugStringW(PCWSTR(wide.as_ptr())) };

            let ts = unsafe { GetLocalTime() };
            let prefix = format!(
                "[{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}] ",
                ts.wYear, ts.wMonth, ts.wDay, ts.wHour, ts.wMinute, ts.wSecond, ts.wMilliseconds
            );
            let mut line = Vec::with_capacity(prefix.len() + buf.len());
            line.extend_from_slice(prefix.as_bytes());
            line.extend_from_slice(buf);
            self.append(&line);
        }
        #[cfg(not(windows))]
        {
            self.append(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn init_logger(log_path: PathBuf) {
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    env_logger::builder()
        .filter_level(LevelFilter::Info)
        .filter_module("reqwest", LevelFilter::Warn)
        .target(env_logger::Target::Pipe(Box::new(RotatingWriter::new(log_path))))
        .format(|f, record| writeln!(f, "LAUNCHER {} {}", record.level(), record.args()))
        .try_init()
        .ok();
}
