//! turbo-surf MCP server binary — newline-delimited JSON-RPC 2.0 over stdio.
//! No Node: one native process reads requests from stdin, writes responses to
//! stdout. The logic lives in the library (`turbo_surf_mcp`).

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use turbo_surf_mcp::{handle, Session};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut session = Session::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue; // skip malformed input rather than crash the server
        };
        if let Some(resp) = handle(&mut session, &req).await {
            let body = serde_json::to_string(&resp).unwrap_or_default();
            let _ = stdout.write_all(body.as_bytes()).await;
            let _ = stdout.write_all(b"\n").await;
            let _ = stdout.flush().await;
        }
    }
}
