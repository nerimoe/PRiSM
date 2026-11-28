//! Native Win32 desktop automation, multi-monitor JPEG capture, and
//! Windows Job Object game process tree management.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use jpeg_encoder::{ColorType, Encoder};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

/// Keep base64 payload comfortably under Cloudflare Durable Object's 1 MiB WebSocket limit.
pub const MAX_SCREENSHOT_BYTES: usize = 700 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum LaunchSpec {
    Exe { app: PathBuf, cmdline: String, cwd: PathBuf },
    Batch { script: PathBuf, cwd: PathBuf },
}

/// Validate that `raw_path` is an existing local absolute `.exe`, `.bat`, or `.cmd`
/// file (no UNC shares, no shell metacharacters for batch scripts).
pub fn validate_launch_path(raw_path: &str) -> Result<LaunchSpec, String> {
    let path = Path::new(raw_path);
    let mut comps = path.components();
    let has_local_drive = match comps.next() {
        Some(Component::Prefix(prefix)) => matches!(
            prefix.kind(),
            std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
        ),
        _ => false,
    };
    if !has_local_drive || !path.is_absolute() || !path.is_file() {
        return Err("目标必须是本机已安装的文件".to_string());
    }
    let cwd = path
        .parent()
        .ok_or_else(|| "目标路径缺少所在目录".to_string())?
        .to_path_buf();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "exe" => Ok(LaunchSpec::Exe {
            app: path.to_path_buf(),
            cmdline: format!("\"{}\"", path.display()),
            cwd,
        }),
        "bat" | "cmd" => {
            if raw_path
                .chars()
                .any(|c| matches!(c, '%' | '!' | '"' | '&' | '|' | '<' | '>' | '^' | '\r' | '\n'))
            {
                return Err("批处理路径包含不允许的字符".to_string());
            }
            Ok(LaunchSpec::Batch {
                script: path.to_path_buf(),
                cwd,
            })
        }
        _ => Err("仅支持 EXE、BAT 和 CMD 文件".to_string()),
    }
}

/// Downscale an RGB24 buffer using a simple box/nearest filter to fit inside `max_w x max_h`.
fn downscale_rgb(src: &[u8], w: usize, h: usize, max_w: usize, max_h: usize) -> (Vec<u8>, usize, usize) {
    if w <= max_w && h <= max_h {
        return (src.to_vec(), w, h);
    }
    let scale = (max_w as f64 / w as f64).min(max_h as f64 / h as f64);
    let nw = ((w as f64 * scale).round() as usize).max(1);
    let nh = ((h as f64 * scale).round() as usize).max(1);
    let mut out = vec![0u8; nw * nh * 3];
    for y in 0..nh {
        let sy = (y * h) / nh;
        for x in 0..nw {
            let sx = (x * w) / nw;
            let si = (sy * w + sx) * 3;
            let di = (y * nw + x) * 3;
            out[di] = src[si];
            out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2];
        }
    }
    (out, nw, nh)
}

/// Encode an RGB24 buffer to JPEG, stepping down quality and resolution if needed
/// to stay below `MAX_SCREENSHOT_BYTES`.
pub fn encode_bounded_jpeg(rgb: &[u8], width: usize, height: usize) -> Result<String, String> {
    for quality in [75u8, 55, 38] {
        let mut buf = Vec::new();
        let encoder = Encoder::new(&mut buf, quality);
        encoder
            .encode(rgb, width as u16, height as u16, ColorType::Rgb)
            .map_err(|e| format!("JPEG 编码失败: {e}"))?;
        if buf.len() <= MAX_SCREENSHOT_BYTES {
            return Ok(BASE64.encode(&buf));
        }
    }
    let (scaled, nw, nh) = downscale_rgb(rgb, width, height, 1920, 1080);
    let mut buf = Vec::new();
    let encoder = Encoder::new(&mut buf, 60);
    encoder
        .encode(&scaled, nw as u16, nh as u16, ColorType::Rgb)
        .map_err(|e| format!("JPEG 编码失败: {e}"))?;
    if buf.len() > MAX_SCREENSHOT_BYTES {
        return Err("截图体积超出传输上限".to_string());
    }
    Ok(BASE64.encode(&buf))
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::ffi::OsStr;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SRCCOPY, SelectObject,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    };
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    use windows::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateMutexW, CreateProcessW, PROCESS_INFORMATION,
        ResumeThread, STARTUPINFOW, TerminateProcess,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, SendInput, VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
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

    pub struct SingleInstance(HANDLE);

    impl SingleInstance {
        /// Acquire `Local\PRiSMLauncher`. Returns `Ok(None)` if another instance is already running.
        pub fn acquire() -> Result<Option<Self>, String> {
            let name = to_wide(r"Local\PRiSMLauncher");
            let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
                .map_err(|e| format!("创建单实例锁失败: {e}"))?;
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                unsafe { let _ = CloseHandle(handle); }
                return Ok(None);
            }
            Ok(Some(Self(handle)))
        }
    }

    impl Drop for SingleInstance {
        fn drop(&mut self) {
            unsafe { let _ = CloseHandle(self.0); }
        }
    }

    /// Owns the currently running game process tree inside a Windows Job Object.
    pub struct Games {
        job: Option<HANDLE>,
        name: Option<String>,
    }

    // `HANDLE` is a kernel handle safe to send between threads when protected by a Mutex.
    unsafe impl Send for Games {}

    impl Games {
        pub fn new() -> Self {
            Self { job: None, name: None }
        }

        fn active_processes(job: HANDLE) -> u32 {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            let ok = unsafe {
                QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    None,
                )
            };
            if ok.is_ok() {
                info.ActiveProcesses
            } else {
                0
            }
        }

        pub fn current(&self) -> Option<String> {
            let job = self.job?;
            if Self::active_processes(job) > 0 {
                self.name.clone()
            } else {
                None
            }
        }

        pub fn switch(&mut self, name: &str, programs: &HashMap<String, String>) -> Result<(), String> {
            let raw_path = programs
                .get(name)
                .ok_or_else(|| "目标程序不在配置列表中".to_string())?;
            let spec = validate_launch_path(raw_path)?;
            let (app, cmdline, cwd) = match spec {
                LaunchSpec::Exe { app, cmdline, cwd } => (app, cmdline, cwd),
                LaunchSpec::Batch { script, cwd } => {
                    let cmd_exe = system_directory()?.join("cmd.exe");
                    let cmdline = format!("\"{}\" /d /s /c \"\"{}\"\"", cmd_exe.display(), script.display());
                    (cmd_exe, cmdline, cwd)
                }
            };

            let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
                .map_err(|e| format!("创建 Job Object 失败: {e}"))?;
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
                unsafe { let _ = CloseHandle(job); }
                return Err(format!("配置 Job Object 失败: {e}"));
            }

            let app_w = to_wide(&app);
            let mut cmd_w = to_wide(&cmdline);
            let cwd_w = to_wide(&cwd);
            let mut si: STARTUPINFOW = unsafe { zeroed() };
            si.cb = size_of::<STARTUPINFOW>() as u32;
            let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };

            let created = unsafe {
                CreateProcessW(
                    PCWSTR(app_w.as_ptr()),
                    PWSTR(cmd_w.as_mut_ptr()),
                    None,
                    None,
                    false,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW,
                    None,
                    PCWSTR(cwd_w.as_ptr()),
                    &si,
                    &mut pi,
                )
            };
            if let Err(e) = created {
                unsafe { let _ = CloseHandle(job); }
                return Err(format!("启动程序失败: {e}"));
            }

            let step = (|| -> Result<(), String> {
                unsafe { AssignProcessToJobObject(job, pi.hProcess) }
                    .map_err(|e| format!("绑定进程到 Job Object 失败: {e}"))?;

                if let Some(old_job) = self.job {
                    unsafe { TerminateJobObject(old_job, 1) }
                        .map_err(|e| format!("结束旧程序失败: {e}"))?;
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while Self::active_processes(old_job) > 0 {
                        if Instant::now() >= deadline {
                            return Err("旧程序尚未退出".to_string());
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    unsafe { let _ = CloseHandle(old_job); }
                    self.job = None;
                }

                let resumed = unsafe { ResumeThread(pi.hThread) };
                if resumed == u32::MAX {
                    return Err("恢复新程序线程失败".to_string());
                }
                self.job = Some(job);
                self.name = Some(name.to_string());
                Ok(())
            })();

            if step.is_err() {
                unsafe {
                    let _ = TerminateProcess(pi.hProcess, 1);
                    let _ = CloseHandle(job);
                }
            }
            unsafe {
                let _ = CloseHandle(pi.hProcess);
                let _ = CloseHandle(pi.hThread);
            }
            step
        }
    }

    impl Drop for Games {
        fn drop(&mut self) {
            if let Some(job) = self.job.take() {
                unsafe { let _ = CloseHandle(job); }
            }
        }
    }

    fn emit_key(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> Result<(), String> {
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let sent = unsafe { SendInput(&[input], size_of::<INPUT>() as i32) };
        if sent != 1 {
            return Err("Windows 拒绝输入".to_string());
        }
        Ok(())
    }

    /// Press a Windows Virtual-Key code `count` times (1s hold + 100ms gap, matching `hinata-io`).
    pub fn press_key(vk: u16, count: u32) -> Result<(), String> {
        if vk == 0 || !(1..=20).contains(&count) {
            return Err("无效按键或次数".to_string());
        }
        for _ in 0..count {
            emit_key(vk, 0, KEYBD_EVENT_FLAGS(0))?;
            std::thread::sleep(Duration::from_secs(1));
            emit_key(vk, 0, KEYEVENTF_KEYUP)?;
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    /// Inject UTF-16 code units into the currently focused window (supports Chinese & Unicode).
    pub fn type_text(text: &str) -> Result<(), String> {
        if text.is_empty() || text.chars().count() > 2048 {
            return Err("无效文本长度".to_string());
        }
        for unit in text.encode_utf16() {
            emit_key(0, unit, KEYEVENTF_UNICODE)?;
            emit_key(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)?;
        }
        Ok(())
    }

    /// Capture the full virtual desktop (all monitors) as a base64 JPEG.
    pub fn screenshot() -> Result<serde_json::Value, String> {
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if w <= 0 || h <= 0 {
                return Err("无法读取屏幕分辨率".to_string());
            }

            let screen_dc = GetDC(None);
            if screen_dc.is_invalid() {
                return Err("无法获取桌面 DC".to_string());
            }
            let mem_dc = CreateCompatibleDC(screen_dc);
            let bmp = CreateCompatibleBitmap(screen_dc, w, h);
            if mem_dc.is_invalid() || bmp.is_invalid() {
                if !bmp.is_invalid() { let _ = DeleteObject(bmp); }
                if !mem_dc.is_invalid() { let _ = DeleteDC(mem_dc); }
                let _ = ReleaseDC(None, screen_dc);
                return Err("创建截图缓冲失败".to_string());
            }

            let old = SelectObject(mem_dc, bmp);
            let blt_ok = BitBlt(mem_dc, 0, 0, w, h, screen_dc, x, y, SRCCOPY);
            SelectObject(mem_dc, old);

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down DIB
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..zeroed()
                },
                ..zeroed()
            };
            let mut bgra = vec![0u8; (w as usize) * (h as usize) * 4];
            let rows = if blt_ok.is_ok() {
                GetDIBits(
                    mem_dc,
                    bmp,
                    0,
                    h as u32,
                    Some(bgra.as_mut_ptr() as *mut _),
                    &mut bmi,
                    DIB_RGB_COLORS,
                )
            } else {
                0
            };

            let _ = DeleteObject(bmp);
            let _ = DeleteDC(mem_dc);
            let _ = ReleaseDC(None, screen_dc);

            if rows == 0 {
                return Err("截取屏幕像素失败".to_string());
            }

            let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
            for px in bgra.chunks_exact(4) {
                rgb.push(px[2]); // R
                rgb.push(px[1]); // G
                rgb.push(px[0]); // B
            }
            let data = encode_bounded_jpeg(&rgb, w as usize, h as usize)?;
            Ok(serde_json::json!({ "mime": "image/jpeg", "data": data }))
        }
    }

    pub fn power(reboot: bool) -> Result<(), String> {
        let exe = system_directory()?.join("shutdown.exe");
        let flag = if reboot { "/r" } else { "/s" };
        let status = Command::new(exe)
            .args([flag, "/t", "0"])
            .creation_flags(CREATE_NO_WINDOW.0)
            .status()
            .map_err(|e| format!("执行电源操作失败: {e}"))?;
        if !status.success() {
            return Err(format!("shutdown.exe 退出码: {:?}", status.code()));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use win::{Games, SingleInstance, power, press_key, screenshot, type_text};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unc_and_unsafe_batch_paths() {
        assert!(validate_launch_path(r"\\server\share\game.exe").is_err());
        assert!(validate_launch_path(r"C:\nonexistent\game.exe").is_err());
        assert!(validate_launch_path(r"C:\games\bad&cmd.bat").is_err());
    }

    #[test]
    fn encodes_rgb_image_under_limit() {
        let rgb = vec![128u8; 64 * 64 * 3];
        let b64 = encode_bounded_jpeg(&rgb, 64, 64).unwrap();
        assert!(!b64.is_empty());
        assert!(b64.len() < 10_000);
    }
}
