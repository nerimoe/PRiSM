//! Safe host filesystem operations and PowerShell process-tree execution
//! for PRiSM Launcher (`host.fs.*` and `host.powershell`).
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf, Prefix};
use std::time::{Instant, UNIX_EPOCH};

use crate::protocol::{FsEncoding, PowerShellFlavor};

/// Keep read/write file payloads comfortably under Cloudflare Durable Object's 1 MiB WebSocket limit.
pub const MAX_FILE_BYTES: usize = 512 * 1024;
pub const MAX_LIST_ENTRIES: usize = 1000;
pub const MAX_PS_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct EffectiveRoots {
    local_enforced: bool,
    local_dirs: Vec<PathBuf>,
    remote_enforced: bool,
    remote_dirs: Vec<PathBuf>,
}

impl EffectiveRoots {
    /// Build the effective allowed-root constraint.
    ///
    /// Local `allowed_roots` from `launcher.json` can NEVER be widened by remote
    /// `node.setConfig` `allowed_roots`. When both are configured, a path must
    /// lie within BOTH sets (intersection). Invalid/nonexistent configured roots
    /// fail closed rather than silently disabling enforcement.
    pub fn resolve(local_roots: &[String], remote_roots: &[String]) -> Self {
        let local_enforced = !local_roots.is_empty();
        let remote_enforced = !remote_roots.is_empty();
        let local_dirs = canonical_root_dirs(local_roots);
        let remote_dirs = canonical_root_dirs(remote_roots);
        Self {
            local_enforced,
            local_dirs,
            remote_enforced,
            remote_dirs,
        }
    }

    pub fn allows(&self, canonical: &Path) -> bool {
        if self.local_enforced && !self.local_dirs.iter().any(|r| path_is_within(canonical, r)) {
            return false;
        }
        if self.remote_enforced && !self.remote_dirs.iter().any(|r| path_is_within(canonical, r)) {
            return false;
        }
        true
    }

    pub fn is_configured_root(&self, canonical: &Path) -> bool {
        self.local_dirs.iter().any(|r| paths_equal(canonical, r))
            || self.remote_dirs.iter().any(|r| paths_equal(canonical, r))
    }
}

fn canonical_root_dirs(raw_roots: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for raw in raw_roots {
        let Ok(parsed) = validate_raw_path(raw) else {
            continue;
        };
        let Ok(canon) = fs::canonicalize(&parsed).and_then(|p| strip_verbatim_and_check_unc(p).map_err(std::io::Error::other)) else {
            continue;
        };
        if canon.is_dir() {
            out.push(canon);
        }
    }
    out
}

/// Perform syntactic validation on a raw path before any filesystem lookup.
///
/// Rejects empty/control-character strings, relative paths (including drive-relative
/// `C:foo`), UNC/device/verbatim paths (`\\server\share`, `\\?\`, `\\.\`, `//server`),
/// traversal segments (`..`), and NTFS alternate data streams (`file.txt:stream`).
pub fn validate_raw_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("路径不能为空".to_string());
    }
    if raw.chars().any(|c| c.is_control()) {
        return Err("路径包含非法控制字符".to_string());
    }
    if raw.starts_with(r"\\") || raw.starts_with("//") {
        return Err("不允许使用 UNC 或设备路径".to_string());
    }
    for seg in raw.split(['/', '\\']) {
        if seg == ".." {
            return Err("路径不允许包含上级目录跳转 (..)".to_string());
        }
    }

    let path = Path::new(raw);
    let mut comps = path.components();

    #[cfg(windows)]
    {
        match comps.next() {
            Some(Component::Prefix(prefix)) => {
                if !matches!(prefix.kind(), Prefix::Disk(_)) {
                    return Err("只允许本机盘符绝对路径".to_string());
                }
            }
            _ => return Err("必须使用绝对路径".to_string()),
        }
        if !matches!(comps.next(), Some(Component::RootDir)) {
            return Err("必须使用完整盘符根目录路径".to_string());
        }
    }

    #[cfg(not(windows))]
    {
        if !matches!(comps.next(), Some(Component::RootDir)) {
            return Err("必须使用绝对路径".to_string());
        }
    }

    for comp in comps {
        match comp {
            Component::ParentDir => {
                return Err("路径不允许包含上级目录跳转 (..)".to_string());
            }
            Component::CurDir => {
                return Err("路径不允许包含相对目录段 (.)".to_string());
            }
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s.contains(':') {
                    return Err("路径分段不允许包含冒号".to_string());
                }
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("路径格式无效".to_string());
            }
        }
    }

    Ok(path.to_path_buf())
}

fn strip_verbatim_and_check_unc(canonical: PathBuf) -> Result<PathBuf, String> {
    let mut comps = canonical.components();
    if let Some(Component::Prefix(prefix)) = comps.next() {
        match prefix.kind() {
            Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _) | Prefix::DeviceNS(_) | Prefix::Verbatim(_) => {
                return Err("不允许解析到 UNC 或设备路径".to_string());
            }
            Prefix::VerbatimDisk(_) => {
                let s = canonical.to_string_lossy();
                if let Some(stripped) = s.strip_prefix(r"\\?\") {
                    return Ok(normalize_drive_case(PathBuf::from(stripped)));
                }
            }
            Prefix::Disk(_) => {
                return Ok(normalize_drive_case(canonical));
            }
        }
    }
    Ok(canonical)
}

fn normalize_drive_case(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        let bytes = s.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_lowercase() {
            let mut out = String::with_capacity(s.len());
            out.push((bytes[0] as char).to_ascii_uppercase());
            out.push_str(&s[1..]);
            return PathBuf::from(out);
        }
    }
    p
}

fn component_key(c: Component<'_>) -> String {
    let s = c.as_os_str().to_string_lossy();
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s.into_owned()
    }
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let p_comps: Vec<String> = path.components().map(component_key).collect();
    let r_comps: Vec<String> = root.components().map(component_key).collect();
    if p_comps.len() < r_comps.len() {
        return false;
    }
    p_comps[..r_comps.len()] == r_comps[..]
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    let a_comps: Vec<String> = a.components().map(component_key).collect();
    let b_comps: Vec<String> = b.components().map(component_key).collect();
    a_comps == b_comps
}

fn canonicalize_checked(path: &Path) -> Result<PathBuf, String> {
    let canon = fs::canonicalize(path).map_err(|e| format!("路径不存在或无法解析: {e}"))?;
    strip_verbatim_and_check_unc(canon)
}

/// Validate an existing path (following symlinks via `canonicalize`), ensuring it
/// does not escape `roots` via symlinks or junctions.
pub fn validate_existing_path(
    raw: &str,
    roots: &EffectiveRoots,
    require_dir: bool,
) -> Result<PathBuf, String> {
    let parsed = validate_raw_path(raw)?;
    if fs::symlink_metadata(&parsed).is_err() {
        return Err("目标路径不存在".to_string());
    }
    let canonical = canonicalize_checked(&parsed)?;
    if !roots.allows(&canonical) {
        return Err("路径超出允许的根目录范围".to_string());
    }
    if require_dir && !canonical.is_dir() {
        return Err("目标路径不是目录".to_string());
    }
    Ok(canonical)
}

/// Validate a path that may or may not yet exist (for `write`, `mkdir`, `rename.to`).
///
/// If the target already exists (including as a symlink), it is canonicalized and
/// checked against `roots` to reject symlink escapes. If it does not exist, its
/// deepest existing ancestor is canonicalized and checked against `roots`, and the
/// non-existing tail is re-attached.
pub fn validate_target_path(
    raw: &str,
    roots: &EffectiveRoots,
    allow_missing_parents: bool,
) -> Result<PathBuf, String> {
    let parsed = validate_raw_path(raw)?;
    if fs::symlink_metadata(&parsed).is_ok() {
        let canonical = canonicalize_checked(&parsed)?;
        if !roots.allows(&canonical) {
            return Err("目标路径超出允许的根目录范围".to_string());
        }
        return Ok(canonical);
    }

    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor: &Path = &parsed;
    loop {
        if fs::symlink_metadata(cursor).is_ok() {
            break;
        }
        let name = cursor
            .file_name()
            .ok_or_else(|| "无法定位目标父目录".to_string())?;
        tail.push(name.to_os_string());
        cursor = cursor
            .parent()
            .ok_or_else(|| "目标父目录不存在".to_string())?;
    }

    if !allow_missing_parents && tail.len() > 1 {
        return Err("目标父目录不存在".to_string());
    }

    let canonical_ancestor = canonicalize_checked(cursor)?;
    if !canonical_ancestor.is_dir() {
        return Err("目标父路径不是目录".to_string());
    }
    if !roots.allows(&canonical_ancestor) {
        return Err("目标路径超出允许的根目录范围".to_string());
    }

    let mut result = canonical_ancestor;
    for seg in tail.into_iter().rev() {
        result.push(seg);
    }
    if !roots.allows(&result) {
        return Err("目标路径超出允许的根目录范围".to_string());
    }
    Ok(result)
}

pub fn is_root_path(canonical: &Path, roots: &EffectiveRoots) -> bool {
    canonical.parent().is_none() || roots.is_configured_root(canonical)
}

pub fn fs_list(raw_path: &str, local_roots: &[String], remote_roots: &[String]) -> Result<Value, String> {
    let roots = EffectiveRoots::resolve(local_roots, remote_roots);
    let dir = validate_existing_path(raw_path, &roots, true)?;
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;

    let mut entries: Vec<(bool, String, Value)> = Vec::new();
    let mut truncated = false;

    for item in read_dir {
        let Ok(entry) = item else {
            continue;
        };
        let entry_path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&entry_path) else {
            continue;
        };
        let is_symlink = meta.file_type().is_symlink();
        let (is_dir, size, modified_ms) = if is_symlink {
            // Skip symlink entries whose target escapes allowed roots so directory
            // listings do not surface unauthorized targets as navigable.
            let Ok(target_canon) = canonicalize_checked(&entry_path) else {
                continue;
            };
            if !roots.allows(&target_canon) {
                continue;
            }
            let target_meta = fs::metadata(&target_canon).ok();
            let modified = target_meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            (
                target_canon.is_dir(),
                target_meta.map(|m| if m.is_dir() { 0 } else { m.len() }).unwrap_or(0),
                modified,
            )
        } else {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            (
                meta.is_dir(),
                if meta.is_dir() { 0 } else { meta.len() },
                modified,
            )
        };

        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let val = json!({
            "name": name,
            "path": entry_path.to_string_lossy(),
            "isDir": is_dir,
            "size": size,
            "modifiedMs": modified_ms,
        });
        entries.push((is_dir, name.to_lowercase(), val));
    }

    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let items: Vec<Value> = entries.into_iter().map(|(_, _, v)| v).collect();

    Ok(json!({
        "path": dir.to_string_lossy(),
        "entries": items,
        "truncated": truncated,
    }))
}

pub fn fs_read(
    raw_path: &str,
    encoding: FsEncoding,
    local_roots: &[String],
    remote_roots: &[String],
) -> Result<Value, String> {
    let roots = EffectiveRoots::resolve(local_roots, remote_roots);
    let file_path = validate_existing_path(raw_path, &roots, false)?;
    if file_path.is_dir() {
        return Err("不能将目录作为文件读取".to_string());
    }
    let meta = fs::metadata(&file_path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    if meta.len() > MAX_FILE_BYTES as u64 {
        return Err(format!("文件超过读取上限 ({MAX_FILE_BYTES} bytes)"));
    }

    let file = fs::File::open(&file_path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取文件失败: {e}"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("文件超过读取上限 ({MAX_FILE_BYTES} bytes)"));
    }

    let size = bytes.len();
    let (enc_name, content) = match encoding {
        FsEncoding::Utf8 => {
            let text = String::from_utf8(bytes)
                .map_err(|_| "文件不是有效的 UTF-8 文本，请改用 base64 读取".to_string())?;
            ("utf8", text)
        }
        FsEncoding::Base64 => ("base64", BASE64.encode(&bytes)),
    };

    Ok(json!({
        "path": file_path.to_string_lossy(),
        "encoding": enc_name,
        "content": content,
        "size": size,
    }))
}

pub fn fs_write(
    raw_path: &str,
    content: &str,
    encoding: FsEncoding,
    create_dirs: bool,
    local_roots: &[String],
    remote_roots: &[String],
) -> Result<Value, String> {
    let bytes: Vec<u8> = match encoding {
        FsEncoding::Utf8 => {
            if content.len() > MAX_FILE_BYTES {
                return Err(format!("写入内容超过上限 ({MAX_FILE_BYTES} bytes)"));
            }
            content.as_bytes().to_vec()
        }
        FsEncoding::Base64 => {
            let decoded = BASE64
                .decode(content)
                .map_err(|e| format!("Base64 内容无效: {e}"))?;
            if decoded.len() > MAX_FILE_BYTES {
                return Err(format!("写入内容超过上限 ({MAX_FILE_BYTES} bytes)"));
            }
            decoded
        }
    };

    let roots = EffectiveRoots::resolve(local_roots, remote_roots);
    let target = validate_target_path(raw_path, &roots, create_dirs)?;
    if target.is_dir() {
        return Err("目标路径是一个目录".to_string());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "目标路径缺少父目录".to_string())?;
    if create_dirs && !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
    }
    // Re-verify parent directory canonical path after optional creation.
    let canonical_parent = canonicalize_checked(parent)?;
    if !roots.allows(&canonical_parent) {
        return Err("目标父目录超出允许的根目录范围".to_string());
    }

    let tmp_name = format!(
        ".prism-tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let tmp_path = canonical_parent.join(tmp_name);
    let mut tmp_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| format!("创建临时文件失败: {e}"))?;

    let write_res = (|| -> Result<(), String> {
        tmp_file
            .write_all(&bytes)
            .map_err(|e| format!("写入临时文件失败: {e}"))?;
        tmp_file
            .sync_all()
            .map_err(|e| format!("刷新文件到磁盘失败: {e}"))?;
        Ok(())
    })();
    drop(tmp_file);

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }

    if let Err(e) = fs::rename(&tmp_path, &target) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("原子替换目标文件失败: {e}"));
    }

    Ok(json!({
        "path": target.to_string_lossy(),
        "bytesWritten": bytes.len(),
    }))
}

pub fn fs_mkdir(
    raw_path: &str,
    recursive: bool,
    local_roots: &[String],
    remote_roots: &[String],
) -> Result<Value, String> {
    let roots = EffectiveRoots::resolve(local_roots, remote_roots);
    let target = validate_target_path(raw_path, &roots, recursive)?;
    if target.exists() {
        if target.is_dir() {
            return Ok(json!({
                "path": target.to_string_lossy(),
                "created": false,
            }));
        }
        return Err("同名文件已存在".to_string());
    }
    if recursive {
        fs::create_dir_all(&target).map_err(|e| format!("创建目录失败: {e}"))?;
    } else {
        fs::create_dir(&target).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    Ok(json!({
        "path": target.to_string_lossy(),
        "created": true,
    }))
}

pub fn fs_rename(
    raw_from: &str,
    raw_to: &str,
    overwrite: bool,
    local_roots: &[String],
    remote_roots: &[String],
) -> Result<Value, String> {
    let roots = EffectiveRoots::resolve(local_roots, remote_roots);
    let from = validate_existing_path(raw_from, &roots, false)?;
    if is_root_path(&from, &roots) {
        return Err("不允许重命名或移动根目录".to_string());
    }
    let to = validate_target_path(raw_to, &roots, false)?;
    if is_root_path(&to, &roots) {
        return Err("不允许覆盖根目录".to_string());
    }
    if paths_equal(&from, &to) {
        return Err("源路径与目标路径相同".to_string());
    }
    if from.is_dir() && path_is_within(&to, &from) {
        return Err("不能将目录移动到自身内部".to_string());
    }

    let to_exists = fs::symlink_metadata(&to).is_ok();
    if to_exists {
        if !overwrite {
            return Err("目标路径已存在".to_string());
        }
        if from.is_dir() != to.is_dir() {
            return Err("源路径与目标路径类型不一致，无法覆盖".to_string());
        }
        if to.is_dir() {
            // Only replace an empty destination directory to avoid accidental tree loss.
            fs::remove_dir(&to).map_err(|e| format!("无法覆盖目标目录: {e}"))?;
        }
    }

    fs::rename(&from, &to).map_err(|e| format!("重命名/移动失败: {e}"))?;
    Ok(json!({
        "from": from.to_string_lossy(),
        "to": to.to_string_lossy(),
    }))
}

pub fn fs_delete(
    raw_path: &str,
    recursive: bool,
    local_roots: &[String],
    remote_roots: &[String],
) -> Result<Value, String> {
    let roots = EffectiveRoots::resolve(local_roots, remote_roots);
    let parsed = validate_raw_path(raw_path)?;
    let meta = fs::symlink_metadata(&parsed).map_err(|_| "目标路径不存在".to_string())?;
    let canonical = canonicalize_checked(&parsed)?;
    if !roots.allows(&canonical) {
        return Err("路径超出允许的根目录范围".to_string());
    }
    if is_root_path(&canonical, &roots) {
        return Err("禁止删除根目录".to_string());
    }
    if meta.file_type().is_symlink() {
        // Delete only the symlink entry itself when its target is inside allowed roots.
        if canonical.is_dir() {
            fs::remove_dir(&parsed).map_err(|e| format!("删除符号链接失败: {e}"))?;
        } else {
            fs::remove_file(&parsed).map_err(|e| format!("删除符号链接失败: {e}"))?;
        }
    } else if canonical.is_dir() {
        if recursive {
            fs::remove_dir_all(&canonical).map_err(|e| format!("递归删除目录失败: {e}"))?;
        } else {
            fs::remove_dir(&canonical).map_err(|e| format!("删除目录失败（目录非空时请开启 recursive）: {e}"))?;
        }
    } else {
        fs::remove_file(&canonical).map_err(|e| format!("删除文件失败: {e}"))?;
    }

    Ok(json!({
        "path": canonical.to_string_lossy(),
        "deleted": true,
    }))
}

/// Resolve and strictly validate the PowerShell working directory, even when `cwd`
/// is omitted (`None`), ensuring remote `allowed_roots` can never widen `local_roots`.
pub fn resolve_powershell_cwd(
    raw_cwd: Option<&str>,
    local_roots: &[String],
    remote_roots: &[String],
    fallback_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let roots = EffectiveRoots::resolve(local_roots, remote_roots);
    if let Some(cwd) = raw_cwd {
        return validate_existing_path(cwd, &roots, true);
    }

    let mut candidates: Vec<String> = Vec::new();
    if !remote_roots.is_empty() {
        candidates.extend(remote_roots.iter().cloned());
    }
    if !local_roots.is_empty() {
        candidates.extend(local_roots.iter().cloned());
    }
    if local_roots.is_empty() && remote_roots.is_empty() {
        if let Some(fb) = fallback_dir {
            candidates.push(fb.to_string_lossy().into_owned());
        } else if let Ok(cur) = std::env::current_dir() {
            candidates.push(cur.to_string_lossy().into_owned());
        }
    }

    for candidate in candidates {
        if let Ok(valid) = validate_existing_path(&candidate, &roots, true) {
            return Ok(valid);
        }
    }

    Err("没有可用的合法工作目录".to_string())
}

fn truncate_utf8_lossy(buf: &[u8]) -> String {
    String::from_utf8_lossy(buf).into_owned()
}

fn read_pipe_capped(mut file: fs::File, cap: usize) -> (String, bool) {
    let mut captured = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 4096];
    loop {
        match file.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if captured.len() < cap {
                    let take = (cap - captured.len()).min(n);
                    captured.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
        }
    }
    (truncate_utf8_lossy(&captured), truncated)
}

#[cfg(windows)]
mod win_ps {
    use super::*;
    use std::ffi::OsStr;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_TIMEOUT,
    };
    use windows::Win32::Security::SECURITY_ATTRIBUTES;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    use windows::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessW, GetExitCodeProcess,
        PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOW, TerminateProcess,
        WaitForSingleObject,
    };
    use windows::core::{PCWSTR, PWSTR};

    fn to_wide(s: impl AsRef<OsStr>) -> Vec<u16> {
        s.as_ref().encode_wide().chain(Some(0)).collect()
    }

    fn system_directory() -> Result<PathBuf, String> {
        let mut buf = [0u16; 260];
        let len = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
        if len == 0 || len >= buf.len() {
            return Err("无法获取 Windows 系统目录".to_string());
        }
        Ok(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
    }

    fn resolve_shell_exe(flavor: PowerShellFlavor) -> Result<PathBuf, String> {
        match flavor {
            PowerShellFlavor::PowerShell => {
                let candidate = system_directory()?
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe");
                if candidate.is_file() {
                    Ok(candidate)
                } else {
                    Err("未找到系统 powershell.exe".to_string())
                }
            }
            PowerShellFlavor::Pwsh => {
                if let Some(paths) = std::env::var_os("PATH") {
                    for dir in std::env::split_paths(&paths) {
                        let cand = dir.join("pwsh.exe");
                        if cand.is_file() {
                            return Ok(cand);
                        }
                    }
                }
                let default_pwsh = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
                if default_pwsh.is_file() {
                    return Ok(default_pwsh);
                }
                Err("未安装 PowerShell 7 (pwsh.exe)".to_string())
            }
        }
    }

    fn create_inheritable_pipe() -> Result<(HANDLE, HANDLE), String> {
        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        let mut read_h = HANDLE::default();
        let mut write_h = HANDLE::default();
        unsafe { CreatePipe(&mut read_h, &mut write_h, Some(&sa), 0) }
            .map_err(|e| format!("创建输出管道失败: {e}"))?;
        if let Err(e) = unsafe { SetHandleInformation(read_h, HANDLE_FLAG_INHERIT.0, Default::default()) } {
            unsafe {
                let _ = CloseHandle(read_h);
                let _ = CloseHandle(write_h);
            }
            return Err(format!("配置管道继承属性失败: {e}"));
        }
        Ok((read_h, write_h))
    }

    pub fn exec_powershell(
        script: &str,
        cwd: &Path,
        timeout_ms: u64,
        flavor: PowerShellFlavor,
    ) -> Result<Value, String> {
        let exe = resolve_shell_exe(flavor)?;
        let wrapped = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8;\n{script}"
        );
        let utf16le: Vec<u8> = wrapped.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let encoded = BASE64.encode(&utf16le);
        let cmdline = format!(
            "\"{}\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}",
            exe.display(),
            encoded
        );

        let (out_read, out_write) = create_inheritable_pipe()?;
        let (err_read, err_write) = match create_inheritable_pipe() {
            Ok(pair) => pair,
            Err(e) => {
                unsafe {
                    let _ = CloseHandle(out_read);
                    let _ = CloseHandle(out_write);
                }
                return Err(e);
            }
        };

        let job = match unsafe { CreateJobObjectW(None, PCWSTR::null()) } {
            Ok(j) => j,
            Err(e) => {
                unsafe {
                    let _ = CloseHandle(out_read);
                    let _ = CloseHandle(out_write);
                    let _ = CloseHandle(err_read);
                    let _ = CloseHandle(err_write);
                }
                return Err(format!("创建 PowerShell Job Object 失败: {e}"));
            }
        };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if let Err(e) = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } {
            unsafe {
                let _ = CloseHandle(job);
                let _ = CloseHandle(out_read);
                let _ = CloseHandle(out_write);
                let _ = CloseHandle(err_read);
                let _ = CloseHandle(err_write);
            }
            return Err(format!("配置 PowerShell Job Object 失败: {e}"));
        }

        let exe_w = to_wide(&exe);
        let mut cmd_w = to_wide(&cmdline);
        let cwd_w = to_wide(cwd);
        let mut si: STARTUPINFOW = unsafe { zeroed() };
        si.cb = size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = HANDLE::default();
        si.hStdOutput = out_write;
        si.hStdError = err_write;
        let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };

        let started = Instant::now();
        let created = unsafe {
            CreateProcessW(
                PCWSTR(exe_w.as_ptr()),
                PWSTR(cmd_w.as_mut_ptr()),
                None,
                None,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                None,
                PCWSTR(cwd_w.as_ptr()),
                &si,
                &mut pi,
            )
        };

        // Close write ends in the parent immediately so EOF triggers when child tree exits.
        unsafe {
            let _ = CloseHandle(out_write);
            let _ = CloseHandle(err_write);
        }

        if let Err(e) = created {
            unsafe {
                let _ = CloseHandle(job);
                let _ = CloseHandle(out_read);
                let _ = CloseHandle(err_read);
            }
            return Err(format!("启动 PowerShell 失败: {e}"));
        }

        if let Err(e) = unsafe { AssignProcessToJobObject(job, pi.hProcess) } {
            unsafe {
                let _ = TerminateProcess(pi.hProcess, 1);
                let _ = CloseHandle(pi.hProcess);
                let _ = CloseHandle(pi.hThread);
                let _ = CloseHandle(job);
                let _ = CloseHandle(out_read);
                let _ = CloseHandle(err_read);
            }
            return Err(format!("绑定 PowerShell 进程到 Job Object 失败: {e}"));
        }

        let resumed = unsafe { ResumeThread(pi.hThread) };
        unsafe {
            let _ = CloseHandle(pi.hThread);
        }
        if resumed == u32::MAX {
            unsafe {
                let _ = TerminateJobObject(job, 1);
                let _ = CloseHandle(pi.hProcess);
                let _ = CloseHandle(job);
                let _ = CloseHandle(out_read);
                let _ = CloseHandle(err_read);
            }
            return Err("恢复 PowerShell 线程失败".to_string());
        }

        let out_file = unsafe { fs::File::from_raw_handle(out_read.0 as _) };
        let err_file = unsafe { fs::File::from_raw_handle(err_read.0 as _) };
        let out_reader = std::thread::spawn(move || read_pipe_capped(out_file, MAX_PS_OUTPUT_BYTES));
        let err_reader = std::thread::spawn(move || read_pipe_capped(err_file, MAX_PS_OUTPUT_BYTES));

        let wait_ms = u32::try_from(timeout_ms).unwrap_or(u32::MAX - 1);
        let wait_res = unsafe { WaitForSingleObject(pi.hProcess, wait_ms) };
        let timed_out = wait_res == WAIT_TIMEOUT;
        let exit_code: Option<i32> = if timed_out {
            unsafe {
                let _ = TerminateJobObject(job, 1);
                let _ = WaitForSingleObject(pi.hProcess, 2000);
            }
            None
        } else {
            let mut code: u32 = 0;
            if unsafe { GetExitCodeProcess(pi.hProcess, &mut code) }.is_ok() {
                Some(code as i32)
            } else {
                None
            }
        };

        let duration_ms = started.elapsed().as_millis() as u64;

        unsafe {
            let _ = CloseHandle(pi.hProcess);
            // Closing the Job Object also ensures any stray descendant processes are terminated.
            let _ = CloseHandle(job);
        }

        let (stdout, stdout_truncated) = out_reader.join().unwrap_or_default();
        let (stderr, stderr_truncated) = err_reader.join().unwrap_or_default();

        Ok(json!({
            "stdout": stdout,
            "stderr": stderr,
            "exitCode": exit_code,
            "timedOut": timed_out,
            "durationMs": duration_ms,
            "stdoutTruncated": stdout_truncated,
            "stderrTruncated": stderr_truncated,
        }))
    }
}

pub fn run_powershell(
    script: &str,
    raw_cwd: Option<&str>,
    timeout_ms: u64,
    flavor: PowerShellFlavor,
    local_roots: &[String],
    remote_roots: &[String],
    fallback_dir: Option<&Path>,
) -> Result<Value, String> {
    let cwd = resolve_powershell_cwd(raw_cwd, local_roots, remote_roots, fallback_dir)?;
    #[cfg(windows)]
    {
        win_ps::exec_powershell(script, &cwd, timeout_ms, flavor)
    }
    #[cfg(not(windows))]
    {
        let _ = (script, timeout_ms, flavor, cwd);
        Err("PowerShell 执行仅支持 Windows 主机".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "prism-launcher-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn rejects_relative_unc_traversal_and_ads_paths() {
        assert!(validate_raw_path("relative.txt").is_err());
        assert!(validate_raw_path(r".\relative.txt").is_err());
        assert!(validate_raw_path(r"C:drive-relative.txt").is_err());
        assert!(validate_raw_path(r"\\server\share\file.txt").is_err());
        assert!(validate_raw_path(r"\\?\C:\Windows\win.ini").is_err());
        assert!(validate_raw_path(r"\\.\PhysicalDrive0").is_err());
        assert!(validate_raw_path("//server/share/file.txt").is_err());
        assert!(validate_raw_path(r"C:\Games\..\Windows\win.ini").is_err());
        assert!(validate_raw_path(r"C:\Games\sub\..\..\secret.txt").is_err());
        assert!(validate_raw_path(r"C:\Games\file.txt:stream").is_err());
    }

    #[test]
    fn local_allowed_roots_cannot_be_widened_by_remote_config() {
        let root = temp_dir("roots");
        let sub = root.join("allowed");
        let outside = root.join("outside");
        fs::create_dir_all(&sub).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let allowed_file = sub.join("ok.txt");
        let outside_file = outside.join("secret.txt");
        fs::write(&allowed_file, "ok").unwrap();
        fs::write(&outside_file, "secret").unwrap();

        let local = vec![sub.to_string_lossy().into_owned()];
        // Remote tries to widen to parent `root` (and also includes `outside`).
        let wider_remote = vec![root.to_string_lossy().into_owned()];
        assert!(
            fs_read(
                &allowed_file.to_string_lossy(),
                FsEncoding::Utf8,
                &local,
                &wider_remote
            )
            .is_ok()
        );
        assert!(
            fs_read(
                &outside_file.to_string_lossy(),
                FsEncoding::Utf8,
                &local,
                &wider_remote
            )
            .is_err()
        );

        // Remote specifies a disjoint root -> intersection is empty -> fail closed!
        let disjoint_remote = vec![outside.to_string_lossy().into_owned()];
        assert!(
            fs_read(
                &allowed_file.to_string_lossy(),
                FsEncoding::Utf8,
                &local,
                &disjoint_remote
            )
            .is_err()
        );
        assert!(
            fs_read(
                &outside_file.to_string_lossy(),
                FsEncoding::Utf8,
                &local,
                &disjoint_remote
            )
            .is_err()
        );

        // Remote can narrow local root.
        let nested = sub.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let nested_file = nested.join("n.txt");
        fs::write(&nested_file, "n").unwrap();
        let narrower_remote = vec![nested.to_string_lossy().into_owned()];
        assert!(
            fs_read(
                &nested_file.to_string_lossy(),
                FsEncoding::Utf8,
                &local,
                &narrower_remote
            )
            .is_ok()
        );
        assert!(
            fs_read(
                &allowed_file.to_string_lossy(),
                FsEncoding::Utf8,
                &local,
                &narrower_remote
            )
            .is_err()
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_deleting_root_directories() {
        let root = temp_dir("delroot");
        let local = vec![root.to_string_lossy().into_owned()];
        assert!(fs_delete(r"C:\", true, &[], &[]).is_err());
        assert!(fs_delete(&root.to_string_lossy(), true, &local, &[]).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn rejects_symlink_escape() {
        let base = temp_dir("symlink");
        let allowed = base.join("allowed");
        let outside = base.join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        fs::write(&secret, "top-secret").unwrap();

        // Try creating a directory symlink (or skip test gracefully only if OS lacks privilege,
        // otherwise assert rejection). On modern Windows with Developer Mode or admin, this works;
        // junction fallback via cmd `mklink /J` works without elevated privileges!
        let escape_dir = allowed.join("escape_dir");
        let linked = std::os::windows::fs::symlink_dir(&outside, &escape_dir).is_ok()
            || std::process::Command::new("cmd")
                .args([
                    "/c",
                    "mklink",
                    "/J",
                    &escape_dir.to_string_lossy(),
                    &outside.to_string_lossy(),
                ])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);

        if linked {
            let local = vec![allowed.to_string_lossy().into_owned()];
            let escaped_file = escape_dir.join("secret.txt");
            assert!(
                fs_read(&escaped_file.to_string_lossy(), FsEncoding::Utf8, &local, &[]).is_err()
            );
            assert!(
                fs_write(
                    &escaped_file.to_string_lossy(),
                    "hacked",
                    FsEncoding::Utf8,
                    false,
                    &local,
                    &[]
                )
                .is_err()
            );
            assert!(fs_list(&escape_dir.to_string_lossy(), &local, &[]).is_err());
            assert!(fs_delete(&escape_dir.to_string_lossy(), true, &local, &[]).is_err());
            assert!(
                resolve_powershell_cwd(
                    Some(&escape_dir.to_string_lossy()),
                    &local,
                    &[],
                    None
                )
                .is_err()
            );
        }

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn file_crud_atomic_write_and_caps_work() {
        let root = temp_dir("crud");
        let local = vec![root.to_string_lossy().into_owned()];

        let sub = root.join("sub");
        let mk = fs_mkdir(&sub.to_string_lossy(), false, &local, &[]).unwrap();
        assert_eq!(mk["created"], true);

        let file_a = sub.join("hello.txt");
        let w1 = fs_write(
            &file_a.to_string_lossy(),
            "你好 PRiSM",
            FsEncoding::Utf8,
            false,
            &local,
            &[],
        )
        .unwrap();
        assert_eq!(w1["bytesWritten"], "你好 PRiSM".len());

        let r1 = fs_read(&file_a.to_string_lossy(), FsEncoding::Utf8, &local, &[]).unwrap();
        assert_eq!(r1["content"], "你好 PRiSM");

        let r_b64 = fs_read(&file_a.to_string_lossy(), FsEncoding::Base64, &local, &[]).unwrap();
        assert_eq!(
            BASE64.decode(r_b64["content"].as_str().unwrap()).unwrap(),
            "你好 PRiSM".as_bytes()
        );

        // Write binary via base64 + atomic overwrite
        let bin_b64 = BASE64.encode([0xFFu8, 0x00, 0x41]);
        fs_write(
            &file_a.to_string_lossy(),
            &bin_b64,
            FsEncoding::Base64,
            false,
            &local,
            &[],
        )
        .unwrap();
        assert!(fs_read(&file_a.to_string_lossy(), FsEncoding::Utf8, &local, &[]).is_err());
        let r_bin = fs_read(&file_a.to_string_lossy(), FsEncoding::Base64, &local, &[]).unwrap();
        assert_eq!(r_bin["content"], bin_b64);

        // Size cap enforcement
        let oversized = "a".repeat(MAX_FILE_BYTES + 1);
        assert!(
            fs_write(
                &file_a.to_string_lossy(),
                &oversized,
                FsEncoding::Utf8,
                false,
                &local,
                &[]
            )
            .is_err()
        );

        // List directory
        let listed = fs_list(&sub.to_string_lossy(), &local, &[]).unwrap();
        assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
        assert_eq!(listed["entries"][0]["name"], "hello.txt");

        // Rename & overwrite guard
        let file_b = sub.join("moved.bin");
        fs_rename(
            &file_a.to_string_lossy(),
            &file_b.to_string_lossy(),
            false,
            &local,
            &[],
        )
        .unwrap();
        assert!(!file_a.exists());
        assert!(file_b.exists());

        fs_write(
            &file_a.to_string_lossy(),
            "x",
            FsEncoding::Utf8,
            false,
            &local,
            &[],
        )
        .unwrap();
        assert!(
            fs_rename(
                &file_a.to_string_lossy(),
                &file_b.to_string_lossy(),
                false,
                &local,
                &[]
            )
            .is_err()
        );

        // Delete file & recursive directory
        fs_delete(&file_b.to_string_lossy(), false, &local, &[]).unwrap();
        assert!(!file_b.exists());
        assert!(fs_delete(&sub.to_string_lossy(), false, &local, &[]).is_err());
        fs_delete(&sub.to_string_lossy(), true, &local, &[]).unwrap();
        assert!(!sub.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn default_powershell_cwd_never_bypasses_local_roots() {
        let base = temp_dir("ps-cwd");
        let local_dir = base.join("local");
        let remote_dir = base.join("remote_wider");
        fs::create_dir_all(&local_dir).unwrap();
        fs::create_dir_all(&remote_dir).unwrap();

        let local = vec![local_dir.to_string_lossy().into_owned()];
        let wider_remote = vec![remote_dir.to_string_lossy().into_owned()];

        // When cwd is None and remote tries to point to a directory outside local_roots,
        // resolve_powershell_cwd MUST fail closed rather than picking remote_wider.
        assert!(resolve_powershell_cwd(None, &local, &wider_remote, Some(&remote_dir)).is_err());

        // When remote is empty, it picks local_dir safely.
        let resolved = resolve_powershell_cwd(None, &local, &[], Some(&remote_dir)).unwrap();
        assert!(paths_equal(&resolved, &canonicalize_checked(&local_dir).unwrap()));

        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn powershell_exec_captures_output_caps_and_kills_process_tree_on_timeout() {
        let root = temp_dir("ps-exec");
        let local = vec![root.to_string_lossy().into_owned()];

        // 1. Normal execution with stdout, stderr, exitCode, and cwd validation
        let res = run_powershell(
            "Write-Output 'hello-中文'; [Console]::Error.WriteLine('err-line'); exit 7",
            None,
            10_000,
            PowerShellFlavor::PowerShell,
            &local,
            &[],
            None,
        )
        .unwrap();
        assert_eq!(res["timedOut"], false);
        assert_eq!(res["exitCode"], 7);
        assert!(res["stdout"].as_str().unwrap().contains("hello-中文"));
        assert!(res["stderr"].as_str().unwrap().contains("err-line"));

        // 2. Output cap test
        let big = run_powershell(
            "$s = 'A' * 80000; [Console]::Out.Write($s)",
            None,
            10_000,
            PowerShellFlavor::PowerShell,
            &local,
            &[],
            None,
        )
        .unwrap();
        assert_eq!(big["stdoutTruncated"], true);
        assert_eq!(big["stdout"].as_str().unwrap().len(), MAX_PS_OUTPUT_BYTES);

        // 3. Timeout kills PowerShell AND spawned child process tree
        let marker = root.join("child-marker.txt");
        let script = format!(
            "Start-Process -NoNewWindow -FilePath cmd.exe -ArgumentList '/c timeout /t 30 /nobreak > nul && echo alive > \"{}\"' ; Start-Sleep -Seconds 30",
            marker.to_string_lossy()
        );
        let timed = run_powershell(
            &script,
            None,
            1_500,
            PowerShellFlavor::PowerShell,
            &local,
            &[],
            None,
        )
        .unwrap();
        assert_eq!(timed["timedOut"], true);
        assert!(timed["exitCode"].is_null());
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!marker.exists());

        let _ = fs::remove_dir_all(&root);
    }
}
