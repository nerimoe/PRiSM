//! Unified PRiSM Node JSON-RPC 2.0 protocol types and replay protection,
//! reusing `hinata-aimeio-rs`'s bounded replay cache and expiry semantics.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SEEN_MESSAGE_CAPACITY: usize = 1024;
pub const MAX_KEY_PRESS_COUNT: u32 = 20;
pub const MAX_TEXT_CHARS: usize = 2048;
pub const MAX_PS_SCRIPT_CHARS: usize = 32 * 1024;
pub const DEFAULT_PS_TIMEOUT_MS: u64 = 15_000;
pub const MIN_PS_TIMEOUT_MS: u64 = 1_000;
pub const MAX_PS_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Deserialize)]
pub struct LocalConfig {
    #[serde(default = "default_update_url")]
    pub update_url: String,
    #[serde(default = "default_auto_update")]
    pub auto_update: bool,
    pub url: String,
    pub token: String,
    #[serde(default, alias = "allowedRoots")]
    pub allowed_roots: Vec<String>,
}

fn default_auto_update() -> bool { true }
fn default_update_url() -> String { "https://github.com/nerimoe/PRiSM/releases/download/launcher-updates/launcher-update.json".into() }

impl LocalConfig {
    /// Parse `launcher.json`, tolerating an optional UTF-8 BOM written by Notepad.
    pub fn parse_str(raw: &str) -> Result<Self, String> {
        let clean = raw.strip_prefix('\u{feff}').unwrap_or(raw);
        let cfg: Self = serde_json::from_str(clean).map_err(|e| format!("解析 launcher.json 失败: {e}"))?;
        if cfg.token.trim().is_empty() {
            return Err("launcher.json 缺少 token".to_string());
        }
        Ok(cfg)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProgramEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct RuntimeConfig {
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub programs: Vec<ProgramEntry>,
    #[serde(default, alias = "allowedRoots")]
    pub allowed_roots: Vec<String>,
}

impl RuntimeConfig {
    pub fn program_map(&self) -> Result<HashMap<String, String>, String> {
        let mut map = HashMap::with_capacity(self.programs.len());
        for p in &self.programs {
            map.insert(p.name.clone(), p.path.clone());
        }
        if let Some(default_name) = &self.default {
            if !map.contains_key(default_name) {
                return Err("默认程序不存在".to_string());
            }
        }
        Ok(map)
    }
}

#[derive(Debug, Deserialize)]
pub struct InboundFrame {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsEncoding {
    Utf8,
    Base64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerShellFlavor {
    PowerShell,
    Pwsh,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HostAction {
    Switch { name: String },
    Key { key: u16, count: u32 },
    Text { text: String },
    UpdateCheck,
    Screenshot,
    Reboot,
    Shutdown,
    FsList { path: String },
    FsRead { path: String, encoding: FsEncoding },
    FsWrite {
        path: String,
        content: String,
        encoding: FsEncoding,
        create_dirs: bool,
    },
    FsMkdir { path: String, recursive: bool },
    FsRename {
        from: String,
        to: String,
        overwrite: bool,
    },
    FsDelete { path: String, recursive: bool },
    PowerShell {
        script: String,
        cwd: Option<String>,
        timeout_ms: u64,
        shell: PowerShellFlavor,
    },
}

fn required_str<'a>(params: &'a Value, key: &str, err: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| err.to_string())
}

fn parse_fs_encoding(params: &Value) -> Result<FsEncoding, String> {
    match params.get("encoding").and_then(Value::as_str) {
        None | Some("utf8") => Ok(FsEncoding::Utf8),
        Some("base64") => Ok(FsEncoding::Base64),
        Some(_) => Err("无效的文件编码格式".to_string()),
    }
}

pub fn parse_host_action(method: &str, params: &Value) -> Result<(u64, HostAction), String> {
    let expires_at = params
        .get("expires_at")
        .and_then(Value::as_u64)
        .ok_or_else(|| "指令缺少有效期".to_string())?;

    let action = match method {
        "host.switch" => {
            let name = required_str(params, "name", "缺少目标程序名")?;
            HostAction::Switch {
                name: name.to_string(),
            }
        }
        "key.press" => {
            let raw_key = params
                .get("key")
                .and_then(Value::as_u64)
                .ok_or_else(|| "无效按键".to_string())?;
            if raw_key == 0 || raw_key > u16::MAX as u64 {
                return Err("无效按键".to_string());
            }
            let count = params.get("count").and_then(Value::as_u64).unwrap_or(1);
            if count == 0 || count > MAX_KEY_PRESS_COUNT as u64 {
                return Err("无效按键次数".to_string());
            }
            HostAction::Key {
                key: raw_key as u16,
                count: count as u32,
            }
        }
        "host.text" => {
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "缺少文本内容".to_string())?;
            let len = text.chars().count();
            if len == 0 || len > MAX_TEXT_CHARS {
                return Err("无效文本长度".to_string());
            }
            HostAction::Text {
                text: text.to_string(),
            }
        }
        "host.update.check" => HostAction::UpdateCheck,
        "host.screenshot" => HostAction::Screenshot,
        "host.reboot" => HostAction::Reboot,
        "host.shutdown" => HostAction::Shutdown,
        "host.fs.list" => HostAction::FsList {
            path: required_str(params, "path", "缺少目录路径")?.to_string(),
        },
        "host.fs.read" => HostAction::FsRead {
            path: required_str(params, "path", "缺少文件路径")?.to_string(),
            encoding: parse_fs_encoding(params)?,
        },
        "host.fs.write" => {
            let path = required_str(params, "path", "缺少文件路径")?.to_string();
            let content = params
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "缺少文件内容".to_string())?
                .to_string();
            let encoding = parse_fs_encoding(params)?;
            let create_dirs = params
                .get("createDirs")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            HostAction::FsWrite {
                path,
                content,
                encoding,
                create_dirs,
            }
        }
        "host.fs.mkdir" => HostAction::FsMkdir {
            path: required_str(params, "path", "缺少目录路径")?.to_string(),
            recursive: params
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        },
        "host.fs.rename" => HostAction::FsRename {
            from: required_str(params, "from", "缺少源路径")?.to_string(),
            to: required_str(params, "to", "缺少目标路径")?.to_string(),
            overwrite: params
                .get("overwrite")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "host.fs.delete" => HostAction::FsDelete {
            path: required_str(params, "path", "缺少删除路径")?.to_string(),
            recursive: params
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        "host.powershell" => {
            let script = required_str(params, "script", "缺少 PowerShell 脚本内容")?;
            if script.chars().count() > MAX_PS_SCRIPT_CHARS {
                return Err("PowerShell 脚本过长".to_string());
            }
            let cwd = match params.get("cwd") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
                Some(Value::String(_)) => return Err("无效的工作目录".to_string()),
                Some(_) => return Err("无效的工作目录".to_string()),
            };
            let timeout_ms = params
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_PS_TIMEOUT_MS);
            if !(MIN_PS_TIMEOUT_MS..=MAX_PS_TIMEOUT_MS).contains(&timeout_ms) {
                return Err("PowerShell 超时时间超出允许范围".to_string());
            }
            let shell = match params.get("shell").and_then(Value::as_str) {
                None | Some("powershell") => PowerShellFlavor::PowerShell,
                Some("pwsh") => PowerShellFlavor::Pwsh,
                Some(_) => return Err("不支持的 PowerShell 类型".to_string()),
            };
            HostAction::PowerShell {
                script: script.to_string(),
                cwd,
                timeout_ms,
                shell,
            }
        }
        other => return Err(format!("未知操作: {other}")),
    };

    Ok((expires_at, action))
}

#[derive(Default)]
pub struct ReplayCache {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl ReplayCache {
    pub fn remember(&mut self, id: &str) -> bool {
        if id.is_empty() || !self.ids.insert(id.to_string()) {
            return false;
        }
        self.order.push_back(id.to_string());
        if self.order.len() > SEEN_MESSAGE_CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
        true
    }
}

pub fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn is_expired(expires_at: u64, now_ms: u64) -> bool {
    expires_at <= now_ms
}

pub fn node_hello_frame(version: &str, model: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "node.hello",
        "params": {
            "version": version,
            "model": model,
        }
    })
    .to_string()
}

pub fn node_heartbeat_frame(program: Option<&str>, uptime_s: u64) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "node.heartbeat",
        "params": {
            "program": program,
            "uptime_s": uptime_s,
        }
    })
    .to_string()
}

pub fn rpc_ok_frame(id: &str, result: Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
    .to_string()
}

pub fn rpc_err_frame(id: &str, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32000,
            "message": message,
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bom_config() {
        let raw = "\u{feff}{\"url\":\"wss://prism.example/node/ws\",\"token\":\"prism_ln_abc\",\"allowed_roots\":[\"D:\\\\Games\"]}";
        let cfg = LocalConfig::parse_str(raw).unwrap();
        assert_eq!(cfg.token, "prism_ln_abc");
        assert_eq!(cfg.allowed_roots, vec!["D:\\Games"]);

        let rt: RuntimeConfig = serde_json::from_value(serde_json::json!({
            "default": null,
            "programs": [],
            "allowedRoots": ["D:\\Games\\Sub"]
        }))
        .unwrap();
        assert_eq!(rt.allowed_roots, vec!["D:\\Games\\Sub"]);
    }

    #[test]
    fn replay_cache_and_expiry_work() {
        let mut cache = ReplayCache::default();
        assert!(cache.remember("id-1"));
        assert!(!cache.remember("id-1"));
        assert!(!cache.remember(""));
        assert!(is_expired(100, 100));
        assert!(is_expired(99, 100));
        assert!(!is_expired(101, 100));
    }

    #[test]
    fn parses_all_host_actions() {
        let (exp, action) = parse_host_action(
            "host.switch",
            &serde_json::json!({"name": "music", "expires_at": 12345}),
        )
        .unwrap();
        assert_eq!(exp, 12345);
        assert_eq!(action, HostAction::Switch { name: "music".into() });

        assert!(parse_host_action("key.press", &serde_json::json!({"key": 0, "expires_at": 1})).is_err());
        assert!(parse_host_action("key.press", &serde_json::json!({"key": 32, "count": 21, "expires_at": 1})).is_err());
        assert_eq!(
            parse_host_action("key.press", &serde_json::json!({"key": 32, "count": 2, "expires_at": 5})).unwrap().1,
            HostAction::Key { key: 32, count: 2 }
        );

        assert_eq!(
            parse_host_action("host.fs.list", &serde_json::json!({"path": "D:\\Games", "expires_at": 5})).unwrap().1,
            HostAction::FsList { path: "D:\\Games".into() }
        );
        assert_eq!(
            parse_host_action("host.fs.read", &serde_json::json!({"path": "D:\\Games\\a.txt", "encoding": "base64", "expires_at": 5})).unwrap().1,
            HostAction::FsRead { path: "D:\\Games\\a.txt".into(), encoding: FsEncoding::Base64 }
        );
        assert!(parse_host_action("host.fs.read", &serde_json::json!({"path": "D:\\Games\\a.txt", "encoding": "hex", "expires_at": 5})).is_err());
        assert_eq!(
            parse_host_action("host.fs.write", &serde_json::json!({"path": "D:\\a.txt", "content": "hi", "createDirs": true, "expires_at": 5})).unwrap().1,
            HostAction::FsWrite { path: "D:\\a.txt".into(), content: "hi".into(), encoding: FsEncoding::Utf8, create_dirs: true }
        );
        assert_eq!(
            parse_host_action("host.fs.mkdir", &serde_json::json!({"path": "D:\\sub", "expires_at": 5})).unwrap().1,
            HostAction::FsMkdir { path: "D:\\sub".into(), recursive: true }
        );
        assert_eq!(
            parse_host_action("host.fs.rename", &serde_json::json!({"from": "D:\\a", "to": "D:\\b", "overwrite": true, "expires_at": 5})).unwrap().1,
            HostAction::FsRename { from: "D:\\a".into(), to: "D:\\b".into(), overwrite: true }
        );
        assert_eq!(
            parse_host_action("host.fs.delete", &serde_json::json!({"path": "D:\\a", "recursive": true, "expires_at": 5})).unwrap().1,
            HostAction::FsDelete { path: "D:\\a".into(), recursive: true }
        );
        assert_eq!(
            parse_host_action("host.powershell", &serde_json::json!({"script": "Get-Date", "cwd": "D:\\Games", "timeoutMs": 30000, "shell": "pwsh", "expires_at": 5})).unwrap().1,
            HostAction::PowerShell { script: "Get-Date".into(), cwd: Some("D:\\Games".into()), timeout_ms: 30000, shell: PowerShellFlavor::Pwsh }
        );
        assert!(parse_host_action("host.powershell", &serde_json::json!({"script": "Get-Date", "timeoutMs": 500, "expires_at": 5})).is_err());
        assert!(parse_host_action("host.powershell", &serde_json::json!({"script": "Get-Date", "timeoutMs": 120001, "expires_at": 5})).is_err());
    }
}
