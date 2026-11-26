#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod host_ops;
mod log;
mod protocol;
mod ws;

use ::log::{error, info, warn};
use futures_util::{SinkExt, StreamExt};
use protocol::{
    HostAction, InboundFrame, LocalConfig, ReplayCache, RuntimeConfig, current_time_millis,
    is_expired, node_heartbeat_frame, node_hello_frame, parse_host_action, rpc_err_frame,
    rpc_ok_frame,
};
use reqwest_websocket::Message;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::time::{MissedTickBehavior, interval, sleep};
use ws::{ConnectError, init_websocket, resolve_endpoint};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);
const MAX_INBOUND_FRAME_BYTES: usize = 1024 * 1024;

struct LauncherState {
    cache_path: PathBuf,
    games: desktop::Games,
    programs: HashMap<String, String>,
    local_allowed_roots: Vec<String>,
    remote_allowed_roots: Vec<String>,
    started: bool,
    replay: ReplayCache,
}

impl LauncherState {
    fn new(cache_path: PathBuf, local_allowed_roots: Vec<String>) -> Self {
        Self {
            cache_path,
            games: desktop::Games::new(),
            programs: HashMap::new(),
            local_allowed_roots,
            remote_allowed_roots: Vec::new(),
            started: false,
            replay: ReplayCache::default(),
        }
    }

    fn apply_config(&mut self, cfg: &RuntimeConfig, persist: bool) -> Result<(), String> {
        let programs = cfg.program_map()?;
        if persist {
            if let Some(parent) = self.cache_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建缓存目录失败: {e}"))?;
            }
            let tmp = self.cache_path.with_extension("tmp");
            let json = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
            fs::write(&tmp, json).map_err(|e| format!("写入配置缓存失败: {e}"))?;
            fs::rename(&tmp, &self.cache_path).map_err(|e| format!("保存配置缓存失败: {e}"))?;
        }
        self.programs = programs;
        self.remote_allowed_roots = cfg.allowed_roots.clone();
        if !self.started {
            if let Some(default_name) = &cfg.default {
                self.games.switch(default_name, &self.programs)?;
                self.started = true;
            }
        }
        Ok(())
    }

    fn current_program(&self) -> Option<String> {
        self.games.current()
    }

    fn allowed_roots(&self) -> (Vec<String>, Vec<String>) {
        (self.local_allowed_roots.clone(), self.remote_allowed_roots.clone())
    }
}

fn app_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn state_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(app_root)
        .join("PRiSM Launcher")
}

fn cache_file_for(state_dir: &Path, endpoint: &str, token: &str) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(endpoint.as_bytes());
    hasher.update(b"\0");
    hasher.update(token.as_bytes());
    let digest = hex::encode(hasher.finalize());
    state_dir.join(format!("{digest}.json"))
}

fn execute_action(state: &Arc<Mutex<LauncherState>>, action: HostAction) -> Result<serde_json::Value, String> {
    match action {
        HostAction::Switch { name } => {
            let mut guard = state.lock().map_err(|_| "内部状态锁定失败".to_string())?;
            let programs = guard.programs.clone();
            guard.games.switch(&name, &programs)?;
            guard.started = true;
            Ok(serde_json::json!({}))
        }
        HostAction::Key { key, count } => {
            desktop::press_key(key, count)?;
            Ok(serde_json::json!({}))
        }
        HostAction::Text { text } => {
            desktop::type_text(&text)?;
            Ok(serde_json::json!({}))
        }
        HostAction::Screenshot => desktop::screenshot(),
        HostAction::Reboot => {
            desktop::power(true)?;
            Ok(serde_json::json!({}))
        }
        HostAction::Shutdown => {
            desktop::power(false)?;
            Ok(serde_json::json!({}))
        }
        HostAction::FsList { path } => {
            let (local_roots, remote_roots) = state
                .lock()
                .map_err(|_| "内部状态锁定失败".to_string())?
                .allowed_roots();
            host_ops::fs_list(&path, &local_roots, &remote_roots)
        }
        HostAction::FsRead { path, encoding } => {
            let (local_roots, remote_roots) = state
                .lock()
                .map_err(|_| "内部状态锁定失败".to_string())?
                .allowed_roots();
            host_ops::fs_read(&path, encoding, &local_roots, &remote_roots)
        }
        HostAction::FsWrite {
            path,
            content,
            encoding,
            create_dirs,
        } => {
            let (local_roots, remote_roots) = state
                .lock()
                .map_err(|_| "内部状态锁定失败".to_string())?
                .allowed_roots();
            host_ops::fs_write(&path, &content, encoding, create_dirs, &local_roots, &remote_roots)
        }
        HostAction::FsMkdir { path, recursive } => {
            let (local_roots, remote_roots) = state
                .lock()
                .map_err(|_| "内部状态锁定失败".to_string())?
                .allowed_roots();
            host_ops::fs_mkdir(&path, recursive, &local_roots, &remote_roots)
        }
        HostAction::FsRename {
            from,
            to,
            overwrite,
        } => {
            let (local_roots, remote_roots) = state
                .lock()
                .map_err(|_| "内部状态锁定失败".to_string())?
                .allowed_roots();
            host_ops::fs_rename(&from, &to, overwrite, &local_roots, &remote_roots)
        }
        HostAction::FsDelete { path, recursive } => {
            let (local_roots, remote_roots) = state
                .lock()
                .map_err(|_| "内部状态锁定失败".to_string())?
                .allowed_roots();
            host_ops::fs_delete(&path, recursive, &local_roots, &remote_roots)
        }
        HostAction::PowerShell {
            script,
            cwd,
            timeout_ms,
            shell,
        } => {
            let (local_roots, remote_roots) = state
                .lock()
                .map_err(|_| "内部状态锁定失败".to_string())?
                .allowed_roots();
            let fallback = app_root();
            host_ops::run_powershell(
                &script,
                cwd.as_deref(),
                timeout_ms,
                shell,
                &local_roots,
                &remote_roots,
                Some(&fallback),
            )
        }
    }
}

async fn run_session(
    ws: reqwest_websocket::WebSocket,
    state: Arc<Mutex<LauncherState>>,
    booted_at: Instant,
) {
    let (mut tx, mut rx) = ws.split();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);

    let model = format!("windows-{}", std::env::consts::ARCH);
    if tx.send(Message::Text(node_hello_frame(VERSION, &model))).await.is_err() {
        return;
    }

    let send_heartbeat = |state: &Arc<Mutex<LauncherState>>| -> String {
        let program = state.lock().ok().and_then(|s| s.current_program());
        node_heartbeat_frame(program.as_deref(), booted_at.elapsed().as_secs())
    };

    if tx.send(Message::Text(send_heartbeat(&state))).await.is_err() {
        return;
    }

    let mut beat = interval(HEARTBEAT_INTERVAL);
    beat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Skip immediate tick since we just sent the initial heartbeat.
    beat.tick().await;

    loop {
        tokio::select! {
            _ = beat.tick() => {
                if let Err(e) = tx.send(Message::Text(send_heartbeat(&state))).await {
                    warn!("发送心跳失败: {e}");
                    break;
                }
            }
            Some(outbound) = out_rx.recv() => {
                if let Err(e) = tx.send(Message::Text(outbound)).await {
                    warn!("发送消息失败: {e}");
                    break;
                }
            }
            incoming = rx.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        handle_inbound(&text, &state, &out_tx, booted_at);
                    }
                    Some(Ok(Message::Close { .. })) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }
}

fn handle_inbound(
    raw: &str,
    state: &Arc<Mutex<LauncherState>>,
    out_tx: &mpsc::Sender<String>,
    booted_at: Instant,
) {
    if raw.len() > MAX_INBOUND_FRAME_BYTES {
        warn!("忽略超大入站消息 ({} bytes)", raw.len());
        return;
    }
    let Ok(frame) = serde_json::from_str::<InboundFrame>(raw) else {
        return;
    };
    let Some(method) = frame.method else {
        return;
    };

    if method == "node.setConfig" {
        let cfg: RuntimeConfig = match serde_json::from_value(frame.params) {
            Ok(c) => c,
            Err(e) => {
                error!("解析下发配置失败: {e}");
                return;
            }
        };
        let state_clone = state.clone();
        let tx = out_tx.clone();
        tokio::task::spawn_blocking(move || {
            let res = state_clone
                .lock()
                .map_err(|_| "内部状态锁定失败".to_string())
                .and_then(|mut guard| guard.apply_config(&cfg, true));
            if let Err(e) = res {
                error!("应用启动配置失败: {e}");
            }
            let program = state_clone.lock().ok().and_then(|s| s.current_program());
            let _ = tx.try_send(node_heartbeat_frame(program.as_deref(), booted_at.elapsed().as_secs()));
        });
        return;
    }

    let Some(id) = frame.id else {
        return;
    };

    let parsed = parse_host_action(&method, &frame.params);
    let action = match parsed {
        Ok((expires_at, action)) => {
            if is_expired(expires_at, current_time_millis()) {
                let _ = out_tx.try_send(rpc_err_frame(&id, "指令已过期"));
                return;
            }
            let accepted = state
                .lock()
                .map(|mut guard| guard.replay.remember(&id))
                .unwrap_or(false);
            if !accepted {
                let _ = out_tx.try_send(rpc_err_frame(&id, "重复指令"));
                return;
            }
            action
        }
        Err(msg) => {
            let _ = out_tx.try_send(rpc_err_frame(&id, &msg));
            return;
        }
    };

    // Execute desktop / process work on a blocking thread so WebSocket heartbeats keep flowing.
    let state_clone = state.clone();
    let tx = out_tx.clone();
    tokio::task::spawn_blocking(move || {
        let reply = match execute_action(&state_clone, action) {
            Ok(result) => rpc_ok_frame(&id, result),
            Err(err) => rpc_err_frame(&id, &err),
        };
        let _ = tx.try_send(reply);
        let program = state_clone.lock().ok().and_then(|s| s.current_program());
        let _ = tx.try_send(node_heartbeat_frame(program.as_deref(), booted_at.elapsed().as_secs()));
    });
}

#[tokio::main]
async fn main() {
    let dir = state_dir();
    log::init_logger(dir.join("launcher.log"));

    let _instance = match desktop::SingleInstance::acquire() {
        Ok(Some(lock)) => lock,
        Ok(None) => return,
        Err(e) => {
            error!("{e}");
            return;
        }
    };

    let config_path = app_root().join("launcher.json");
    let raw = match fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(e) => {
            error!("读取 {} 失败: {e}", config_path.display());
            return;
        }
    };
    let local_cfg = match LocalConfig::parse_str(&raw) {
        Ok(c) => c,
        Err(e) => {
            error!("{e}");
            return;
        }
    };
    let endpoint = match resolve_endpoint(&local_cfg.url) {
        Ok(u) => u,
        Err(e) => {
            error!("{e}");
            return;
        }
    };

    let cache_path = cache_file_for(&dir, &endpoint, &local_cfg.token);
    let state = Arc::new(Mutex::new(LauncherState::new(
        cache_path.clone(),
        local_cfg.allowed_roots.clone(),
    )));

    if cache_path.exists() {
        match fs::read_to_string(&cache_path)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<RuntimeConfig>(&s).map_err(|e| e.to_string()))
        {
            Ok(cached) => {
                if let Err(e) = state.lock().unwrap().apply_config(&cached, false) {
                    error!("缓存启动失败: {e}");
                }
            }
            Err(e) => error!("读取缓存配置失败: {e}"),
        }
    }

    let booted_at = Instant::now();
    let mut delay = Duration::from_secs(2);
    let max_delay = Duration::from_secs(60);

    loop {
        info!("正在连接平台节点通道: {endpoint}");
        match init_websocket(&endpoint, &local_cfg.token).await {
            Ok(ws) => {
                info!("已连接到 PRiSM 平台");
                delay = Duration::from_secs(2);
                run_session(ws, state.clone(), booted_at).await;
                warn!("平台连接已断开");
            }
            Err(ConnectError::Unauthorized(status)) => {
                error!("节点令牌被拒绝 (HTTP {status})，请更新 launcher.json 后重启 Launcher");
                // Keep ownership of the running game Job Object while waiting for operator restart.
                std::future::pending::<()>().await;
            }
            Err(ConnectError::Other(err)) => {
                warn!("连接失败 ({err})，将在 {:?} 后重试", delay);
            }
        }
        sleep(delay).await;
        delay = std::cmp::min(delay * 2, max_delay);
    }
}
