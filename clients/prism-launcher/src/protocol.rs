//! Unified PRiSM Node JSON-RPC 2.0 protocol types and replay protection,
//! reusing `hinata-aimeio-rs`'s bounded replay cache and expiry semantics.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

pub const SEEN_MESSAGE_CAPACITY: usize = 1024;
pub const MAX_KEY_PRESS_COUNT: u32 = 20;
pub const MAX_TEXT_CHARS: usize = 2048;

#[derive(Debug, Deserialize)]
pub struct LocalConfig {
    pub url: String,
    pub token: String,
}

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

#[derive(Debug, PartialEq, Eq)]
pub enum HostAction {
    Switch { name: String },
    Key { key: u16, count: u32 },
    Text { text: String },
    Screenshot,
    Reboot,
    Shutdown,
}

pub fn parse_host_action(method: &str, params: &Value) -> Result<(u64, HostAction), String> {
    let expires_at = params
        .get("expires_at")
        .and_then(Value::as_u64)
        .ok_or_else(|| "指令缺少有效期".to_string())?;

    let action = match method {
        "host.switch" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "缺少目标程序名".to_string())?;
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
        "host.screenshot" => HostAction::Screenshot,
        "host.reboot" => HostAction::Reboot,
        "host.shutdown" => HostAction::Shutdown,
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
        let raw = "\u{feff}{\"url\":\"wss://prism.example/node/ws\",\"token\":\"prism_ln_abc\"}";
        let cfg = LocalConfig::parse_str(raw).unwrap();
        assert_eq!(cfg.token, "prism_ln_abc");
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
    }
}
