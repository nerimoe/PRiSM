//! Background updates replace the on-disk executable; the running process is never restarted.
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}, sync::{Arc, OnceLock}, time::Duration};
use tokio::sync::Mutex;

const MAX_DOWNLOAD: usize = 64 * 1024 * 1024;
static UPDATER: OnceLock<Arc<Mutex<Updater>>> = OnceLock::new();

#[derive(Deserialize)]
struct Manifest { version: String, url: String, sha256: String, target: String }
struct Updater { exe: PathBuf, url: String, pending: Option<String> }

pub fn start(url: String, enabled: bool) {
    let Ok(exe) = std::env::current_exe() else { return };
    // A previous process may still hold the backup open. Failure is harmless.
    let _ = fs::remove_file(exe.with_extension("exe.old"));
    let _ = UPDATER.set(Arc::new(Mutex::new(Updater { exe, url, pending: None })));
    if enabled {
        tokio::spawn(async {
            loop {
                if let Err(e) = check().await { log::warn!("更新检查失败: {e}"); }
                tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
            }
        });
    }
}

pub async fn check() -> Result<Value, String> {
    let updater = UPDATER.get().ok_or("更新器未初始化")?;
    let Ok(mut state) = updater.try_lock() else {
        return Ok(json!({"status":"checking"}));
    };
    if let Some(version) = &state.pending {
        return Ok(json!({"status":"pending", "version":version}));
    }
    let result = state.download().await;
    result.map_err(|e| e.to_string())
}

impl Updater {
    async fn download(&mut self) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let client = reqwest::Client::builder().https_only(true)
            .timeout(Duration::from_secs(25)).build()?;
        let raw = limited(&client, &self.url, 16 * 1024).await?;
        let manifest: Manifest = serde_json::from_slice(&raw)?;
        let remote = semver::Version::parse(manifest.version.trim_start_matches('v'))?;
        let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))?;
        if remote <= current || !remote.pre.is_empty() {
            return Ok(json!({"status":"current"}));
        }
        if manifest.target != format!("{}-pc-windows-msvc", std::env::consts::ARCH) { return Err("更新架构不匹配".into()); }
        let bytes = limited(&client, &manifest.url, MAX_DOWNLOAD).await?;
        verify(&bytes, &manifest.sha256)?;
        replace(&self.exe, &bytes)?;
        self.pending = Some(remote.to_string());
        log::info!("新版 {} 已下载，下次启动生效", remote);
        Ok(json!({"status":"pending", "version":remote.to_string()}))
    }
}

async fn limited(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > limit { return Err("更新文件过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn verify(bytes: &[u8], expected: &str) -> Result<(), String> {
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit())
        || hex::encode(Sha256::digest(bytes)) != expected.to_ascii_lowercase() {
        return Err("更新校验失败".into());
    }
    if !bytes.starts_with(b"MZ") { return Err("更新不是 Windows 可执行文件".into()); }
    Ok(())
}

fn replace(exe: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = exe.with_extension("exe.tmp");
    let old = exe.with_extension("exe.old");
    fs::write(&temp, bytes)?;
    if let Err(e) = fs::rename(exe, &old) { let _ = fs::remove_file(&temp); return Err(e); }
    if let Err(e) = fs::rename(&temp, exe) {
        let rollback = fs::rename(&old, exe);
        return Err(std::io::Error::other(format!("替换失败: {e}; 回滚: {rollback:?}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksum_rejects_corruption_and_non_executable() {
        let bytes = b"MZtest";
        assert!(verify(bytes, &hex::encode(Sha256::digest(bytes))).is_ok());
        assert!(verify(b"MZbad", &hex::encode(Sha256::digest(bytes))).is_err());
        assert!(verify(b"html", &hex::encode(Sha256::digest(b"html"))).is_err());
    }
    #[test]
    fn running_image_can_be_replaced() {
        if let Ok(marker) = std::env::var("PRISM_UPDATE_TEST_MARKER") {
            fs::write(marker, b"ready").unwrap();
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        let dir = std::env::temp_dir().join(format!("prism-live-update-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("launcher.exe");
        fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
        let marker = dir.join("ready");
        let mut child = std::process::Command::new(&exe)
            .args(["--exact", "updater::tests::running_image_can_be_replaced"])
            .env("PRISM_UPDATE_TEST_MARKER", &marker).spawn().unwrap();
        for _ in 0..100 {
            if marker.exists() { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        let ready = marker.exists();
        let result = replace(&exe, b"new");
        let alive = child.try_wait().unwrap().is_none();
        let _ = child.kill(); let _ = child.wait();
        fs::remove_dir_all(dir).unwrap();
        result.unwrap(); assert!(ready); assert!(alive);
    }
    #[test]
    fn replacement_preserves_backup() {
        let dir = std::env::temp_dir().join(format!("prism-update-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("launcher.exe");
        fs::write(&exe, b"old").unwrap();
        replace(&exe, b"new").unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"new");
        assert_eq!(fs::read(exe.with_extension("exe.old")).unwrap(), b"old");
        fs::remove_dir_all(dir).unwrap();
    }
}
