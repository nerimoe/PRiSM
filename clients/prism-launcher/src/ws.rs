//! WebSocket transport for PRiSM edge nodes, reusing `hinata-io`'s
//! `reqwest` + `reqwest-websocket` Bearer-upgrade pattern and status classification.
use reqwest::Client;
use reqwest::header::AUTHORIZATION;
use reqwest_websocket::{HandshakeError, Upgrade, WebSocket};
use url::Url;

#[derive(Debug, PartialEq, Eq)]
pub enum ConnectError {
    /// Server explicitly refused the credential (401/403): stop retrying.
    Unauthorized(u16),
    /// Transient transport or server error: retry with backoff.
    Other(String),
}

/// Normalize and validate the configured platform endpoint.
///
/// Only `wss://` is accepted for remote hosts; plain `ws://` is permitted solely
/// for local loopback development (`localhost`, `127.0.0.1`, `::1`).
pub fn resolve_endpoint(raw_url: &str) -> Result<String, String> {
    let mut url = Url::parse(raw_url.trim()).map_err(|e| format!("平台地址无效: {e}"))?;
    match url.scheme() {
        "wss" => {}
        "ws" => {
            let host = url.host_str().unwrap_or("");
            if !matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]") {
                return Err("请使用 wss:// 平台地址".to_string());
            }
        }
        _ => return Err("请使用 wss:// 平台地址".to_string()),
    }
    if url.path().is_empty() || url.path() == "/" {
        url.set_path("/node/ws");
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

/// Open an authenticated WebSocket connection (`no_proxy` + `http1_only`).
pub async fn init_websocket(url: &str, token: &str) -> Result<WebSocket, ConnectError> {
    let mut request = Client::builder()
        .http1_only()
        .no_proxy()
        .build()
        .map_err(|e| ConnectError::Other(e.to_string()))?
        .get(url);
    if !token.is_empty() {
        request = request.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    request
        .upgrade()
        .send()
        .await
        .map_err(classify_error)?
        .into_websocket()
        .await
        .map_err(classify_error)
}

fn classify_error(error: reqwest_websocket::Error) -> ConnectError {
    if let reqwest_websocket::Error::Handshake(HandshakeError::UnexpectedStatusCode(status)) = &error
    {
        let code = status.as_u16();
        if code == 401 || code == 403 {
            return ConnectError::Unauthorized(code);
        }
    }
    ConnectError::Other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_default_node_path_and_rejects_remote_ws() {
        assert_eq!(
            resolve_endpoint("wss://prism.example").unwrap(),
            "wss://prism.example/node/ws"
        );
        assert_eq!(
            resolve_endpoint("wss://prism.example/node/ws?role=old").unwrap(),
            "wss://prism.example/node/ws"
        );
        assert_eq!(
            resolve_endpoint("ws://127.0.0.1:8787/node/ws").unwrap(),
            "ws://127.0.0.1:8787/node/ws"
        );
        assert!(resolve_endpoint("ws://prism.example/node/ws").is_err());
        assert!(resolve_endpoint("https://prism.example/node/ws").is_err());
    }
}
