// slm-log-agent: tails a Squad server's SquadGame.log and streams it to Squad Layer Manager over a
// WebSocket. See ../../src/systems/squad-logs-receiver.server.ts for the other end of the protocol.
//
// Protocol:
//   1. connect to `wss://<origin>/log-agent` (or ws:// for plaintext)
//   2. send one text frame: `slm-log-agent@<version>:<serverId>:<token>`
//   3. expect a `ok` text frame back (any other reply / close means rejected)
//   4. stream raw log bytes as binary frames, resuming from our own byte offset across reconnects
//
// Kept small and dependency-light on purpose: it runs on the game host, next to the server it watches.

use std::io::SeekFrom;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use tokio::fs;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

const VERSION: &str = "0.1.0";

// read the file in bounded slices so a big backlog (e.g. first read of a long-disconnected agent) streams
// as several frames with backpressure between them rather than one giant allocation
const READ_CHUNK: usize = 64 * 1024;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

struct Config {
    url: String,
    server_id: String,
    token: String,
    file: String,
    reconnect: Duration,
    poll: Duration,
    insecure: bool,
    log_file: Option<String>,
}

fn main() {
    let cfg = match Config::parse() {
        Ok(cfg) => cfg,
        Err(msg) => {
            eprintln!("{msg}");
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };
    // rustls has no built-in default provider without aws-lc-rs, so register ring as the process default
    // that ClientConfig::builder() picks up
    let _ = rustls::crypto::ring::default_provider().install_default();

    let logger = Logger::new(cfg.log_file.clone());
    logger.info(&format!(
        "starting slm-log-agent@{VERSION} (pid {}) for server {} -> {}",
        std::process::id(),
        cfg.server_id,
        cfg.url
    ));

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");
    rt.block_on(run(cfg, logger));
}

async fn run(cfg: Config, log: Logger) {
    // our byte position in the log file. `None` until the first successful stat, at which point we jump to
    // end-of-file so we stream only new lines rather than replaying the whole existing log. It persists
    // across reconnects, so a blip replays exactly what was appended while we were gone.
    let mut offset: Option<u64> = None;

    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);

    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => {
                log.info("shutting down");
                return;
            }
            result = connect_and_stream(&cfg, &log, &mut offset) => {
                match result {
                    Ok(()) => log.info("connection closed by server"),
                    Err(err) => log.error(&format!("connection ended: {err}")),
                }
            }
        }

        // wait out the reconnect delay, but stay responsive to shutdown
        tokio::select! {
            biased;
            _ = &mut shutdown => {
                log.info("shutting down");
                return;
            }
            _ = tokio::time::sleep(cfg.reconnect) => {}
        }
    }
}

async fn connect_and_stream(
    cfg: &Config,
    log: &Logger,
    offset: &mut Option<u64>,
) -> Result<(), String> {
    let target = Target::parse(&cfg.url)?;
    let request = cfg
        .url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("invalid url: {e}"))?;

    let tcp = TcpStream::connect((target.host.as_str(), target.port))
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    // log lines are small and latency matters; don't sit in Nagle's buffer
    let _ = tcp.set_nodelay(true);

    // the two schemes yield different concrete stream types, so hand each to the same generic driver
    if target.tls {
        let connector = TlsConnector::from(tls_config(cfg.insecure));
        let server_name = ServerName::try_from(target.host.clone())
            .map_err(|e| format!("invalid tls server name: {e}"))?;
        let tls = connector
            .connect(server_name, tcp)
            .await
            .map_err(|e| format!("tls handshake failed: {e}"))?;
        let (ws, _resp) = tokio_tungstenite::client_async(request, tls)
            .await
            .map_err(|e| format!("websocket handshake failed: {e}"))?;
        drive(cfg, log, offset, ws).await
    } else {
        let (ws, _resp) = tokio_tungstenite::client_async(request, tcp)
            .await
            .map_err(|e| format!("websocket handshake failed: {e}"))?;
        drive(cfg, log, offset, ws).await
    }
}

async fn drive<S>(
    cfg: &Config,
    log: &Logger,
    offset: &mut Option<u64>,
    ws: WebSocketStream<S>,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut write, mut read) = ws.split();

    // handshake
    write
        .send(Message::Text(format!(
            "slm-log-agent@{VERSION}:{}:{}",
            cfg.server_id, cfg.token
        )))
        .await
        .map_err(|e| format!("failed to send handshake: {e}"))?;

    match tokio::time::timeout(HANDSHAKE_TIMEOUT, read.next()).await {
        Ok(Some(Ok(Message::Text(t)))) if t == "ok" => {}
        Ok(Some(Ok(Message::Close(frame)))) => {
            return Err(format!("server rejected handshake: {frame:?}"));
        }
        Ok(Some(Ok(other))) => return Err(format!("unexpected handshake reply: {other:?}")),
        Ok(Some(Err(e))) => return Err(format!("handshake read error: {e}")),
        Ok(None) => return Err("server closed during handshake".into()),
        Err(_) => return Err("handshake timed out".into()),
    }

    log.info("connected");

    // drive the read half in the background: it auto-responds to pings (the split halves share the
    // underlying socket via a lock) and tells us when the server hangs up.
    let mut reader = tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });

    loop {
        tokio::select! {
            biased;
            _ = &mut reader => {
                // server closed or the read side errored; return so the caller reconnects
                return Ok(());
            }
            result = pump_file(cfg, log, offset, &mut write) => {
                result?;
            }
        }

        tokio::select! {
            biased;
            _ = &mut reader => return Ok(()),
            _ = tokio::time::sleep(cfg.poll) => {}
        }
    }
}

// reads whatever has been appended since `offset` and sends it, updating `offset`. Rotation/truncation
// (offset past the current end) restarts from the top of the new file, matching how the game rolls its log.
async fn pump_file(
    cfg: &Config,
    log: &Logger,
    offset: &mut Option<u64>,
    write: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
) -> Result<(), String> {
    let size = match fs::metadata(&cfg.file).await {
        Ok(meta) => meta.len(),
        // the file may not exist yet if the server is still starting; try again next poll
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("stat {} failed: {e}", cfg.file)),
    };

    let start = match offset {
        // first observation: start streaming from the current end, skipping existing history
        None => {
            *offset = Some(size);
            return Ok(());
        }
        Some(o) => *o,
    };

    if start > size {
        log.info("log file shrank (rotated or truncated), restarting from its start");
        *offset = Some(0);
        return Ok(());
    }
    if start == size {
        return Ok(());
    }

    let mut file = fs::File::open(&cfg.file)
        .await
        .map_err(|e| format!("open {} failed: {e}", cfg.file))?;
    file.seek(SeekFrom::Start(start))
        .await
        .map_err(|e| format!("seek failed: {e}"))?;

    let mut remaining = size - start;
    let mut pos = start;
    let mut buf = vec![0u8; READ_CHUNK];
    while remaining > 0 {
        let want = remaining.min(READ_CHUNK as u64) as usize;
        let n = file
            .read(&mut buf[..want])
            .await
            .map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        // `send().await` applies backpressure: it resolves once the frame is accepted by the sink
        write
            .send(Message::Binary(buf[..n].to_vec()))
            .await
            .map_err(|e| format!("send failed: {e}"))?;
        pos += n as u64;
        remaining -= n as u64;
        *offset = Some(pos);
    }

    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
        let mut int = signal(SignalKind::interrupt()).expect("failed to install SIGINT handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

// --------  url --------

struct Target {
    host: String,
    port: u16,
    tls: bool,
}

impl Target {
    fn parse(url: &str) -> Result<Target, String> {
        let (tls, rest) = if let Some(r) = url.strip_prefix("wss://") {
            (true, r)
        } else if let Some(r) = url.strip_prefix("ws://") {
            (false, r)
        } else {
            return Err(format!("url must start with ws:// or wss://: {url}"));
        };
        // authority is everything up to the first '/', '?' or '#'
        let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
        if authority.is_empty() {
            return Err(format!("url is missing a host: {url}"));
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (
                h.to_string(),
                p.parse()
                    .map_err(|_| format!("invalid port in url: {url}"))?,
            ),
            None => (authority.to_string(), if tls { 443 } else { 80 }),
        };
        Ok(Target { host, port, tls })
    }
}

// --------  TLS --------

fn tls_config(insecure: bool) -> Arc<rustls::ClientConfig> {
    let builder = rustls::ClientConfig::builder();
    if insecure {
        // skip verification entirely: for hosts fronted by a self-signed or IP-only cert
        let schemes = rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes();
        return Arc::new(
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerify { schemes }))
                .with_no_client_auth(),
        );
    }
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    Arc::new(builder.with_root_certificates(roots).with_no_client_auth())
}

// Accepts any server certificate. Only reachable behind `--insecure`.
#[derive(Debug)]
struct NoVerify {
    schemes: Vec<rustls::SignatureScheme>,
}

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.schemes.clone()
    }
}

// --------  logging --------

// Line-oriented logs to stdout, optionally mirrored to a file. The `[LOG]`/`[ERROR]` prefix and the
// single timestamp token are what the SquadJS plugin scrapes to surface agent status in its own logs.
struct Logger {
    file: std::sync::Mutex<Option<std::fs::File>>,
}

impl Logger {
    fn new(path: Option<String>) -> Self {
        let file = path.and_then(|p| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&p)
                .map_err(|e| eprintln!("could not open log file {p}: {e}"))
                .ok()
        });
        Logger {
            file: std::sync::Mutex::new(file),
        }
    }

    fn info(&self, msg: &str) {
        self.write("LOG", msg);
    }

    fn error(&self, msg: &str) {
        self.write("ERROR", msg);
    }

    fn write(&self, level: &str, msg: &str) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let line = format!("[{level}] {ts} {msg}");
        if level == "ERROR" {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
        if let Ok(mut guard) = self.file.lock() {
            if let Some(f) = guard.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "{line}");
            }
        }
    }
}

// --------  config / args --------

const USAGE: &str = "\
usage: slm-log-agent --url <ws-url> --server-id <id> --token <token> --file <path> [options]

  --url <url>            SLM websocket url, e.g. wss://slm.example.com/log-agent   [env SLM_URL]
  --server-id <id>       server id as configured in SLM                            [env SLM_SERVER_ID]
  --token <token>        the log-receiver token for that server                    [env SLM_TOKEN]
  --file <path>          path to SquadGame.log                                     [env SLM_LOG_PATH]
  --reconnect-ms <n>     delay between reconnect attempts (default 5000)           [env SLM_RECONNECT_MS]
  --poll-ms <n>          how often to check the log for new data (default 1000)    [env SLM_POLL_MS]
  --log-file <path>      also append agent logs to this file                       [env SLM_AGENT_LOG]
  --insecure             do not verify the server's TLS certificate                [env SLM_INSECURE=1]
";

impl Config {
    fn parse() -> Result<Config, String> {
        let mut url = std::env::var("SLM_URL").ok();
        let mut server_id = std::env::var("SLM_SERVER_ID").ok();
        let mut token = std::env::var("SLM_TOKEN").ok();
        let mut file = std::env::var("SLM_LOG_PATH").ok();
        let mut log_file = std::env::var("SLM_AGENT_LOG").ok();
        let mut reconnect_ms: u64 = env_u64("SLM_RECONNECT_MS")?.unwrap_or(5000);
        let mut poll_ms: u64 = env_u64("SLM_POLL_MS")?.unwrap_or(1000);
        let mut insecure = matches!(
            std::env::var("SLM_INSECURE").ok().as_deref(),
            Some("1") | Some("true")
        );

        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--url" => url = Some(take(&mut args, "--url")?),
                "--server-id" => server_id = Some(take(&mut args, "--server-id")?),
                "--token" => token = Some(take(&mut args, "--token")?),
                "--file" => file = Some(take(&mut args, "--file")?),
                "--log-file" => log_file = Some(take(&mut args, "--log-file")?),
                "--reconnect-ms" => {
                    reconnect_ms = take(&mut args, "--reconnect-ms")?
                        .parse()
                        .map_err(|_| "--reconnect-ms must be a number".to_string())?
                }
                "--poll-ms" => {
                    poll_ms = take(&mut args, "--poll-ms")?
                        .parse()
                        .map_err(|_| "--poll-ms must be a number".to_string())?
                }
                "--insecure" => insecure = true,
                "-h" | "--help" => {
                    println!("{USAGE}");
                    std::process::exit(0);
                }
                other => return Err(format!("unknown argument: {other}")),
            }
        }

        Ok(Config {
            url: require(url, "--url / SLM_URL")?,
            server_id: require(server_id, "--server-id / SLM_SERVER_ID")?,
            token: require(token, "--token / SLM_TOKEN")?,
            file: require(file, "--file / SLM_LOG_PATH")?,
            reconnect: Duration::from_millis(reconnect_ms),
            poll: Duration::from_millis(poll_ms),
            insecure,
            log_file,
        })
    }
}

fn take(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn require(value: Option<String>, what: &str) -> Result<String, String> {
    value
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("missing required {what}"))
}

fn env_u64(key: &str) -> Result<Option<u64>, String> {
    match std::env::var(key) {
        Ok(v) => v
            .parse()
            .map(Some)
            .map_err(|_| format!("{key} must be a number")),
        Err(_) => Ok(None),
    }
}
