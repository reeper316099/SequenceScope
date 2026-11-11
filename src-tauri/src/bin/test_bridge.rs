//! DEV-ONLY test bridge. It is not part of the shipped app (it only builds with `--features test-bridge`).
//!
//! It lets the browser tests (tests/bridge, Playwright + Chromium) exercise the REAL Rust core: it serves the built UI
//! (out/tauri-renderer) with the app's production Content-Security-Policy, and answers `POST /invoke/<command>` by calling
//! the same plain functions the Tauri commands call (`run_align`, `run_op`, ...). The page side is a few lines of
//! JavaScript (tests/bridge/shim.ts) that stands in for Tauri's `invoke`.
//!
//! Safety: it listens on 127.0.0.1 only, refuses any request whose Host is not 127.0.0.1/localhost (DNS rebinding), serves
//! files only from the folder it was given (no `..`, no symlinks out), and has no file-writing or dialog commands.
//!
//! Reply format of `/invoke/*` (streamed): repeated `[kind: u8][length: u32 LE][payload]` where kind is
//! `P` progress (JSON `{"fraction":0.4}`), `J` JSON result, `B` binary result, `E` error (JSON `{"code","message"}`).

use sequencescope_lib::bridge_api::{
    AlignRequestDto, BootstrapRequestDto, DistancesRequestDto, JobError, Jobs, MsaRequestDto, OpRequest,
    ShuffleRequestDto, parse_request, run_align, run_bootstrap, run_distances, run_msa, run_op, run_shuffle,
};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// Test hook: while set, every new job waits (still registered as running) until it is cancelled or the hook is cleared, so a
/// test can click Cancel on a job that is certain to still be running, however fast the machine is.
static HOLD_JOBS: AtomicBool = AtomicBool::new(false);

/// Largest request body accepted (the biggest legitimate request is a 50-sequence FASTA set, a few MB).
const MAX_BODY: u64 = 64 * 1024 * 1024;

/// Settings read from the command line.
struct Config {
    root: PathBuf,
    port: u16,
    csp: String,
}

/// Reads `--serve <dir> [--port <n>] [--conf <tauri.conf.json>]`; a missing value is a usage error.
fn parse_args() -> Result<Config, String> {
    let mut root = None;
    let mut port = 0u16;
    let mut conf = PathBuf::from("src-tauri/tauri.conf.json");
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--serve" => root = Some(PathBuf::from(value)),
            "--port" => port = value.parse().map_err(|_| "--port must be a number".to_string())?,
            "--conf" => conf = PathBuf::from(value),
            other => return Err(format!("unknown option {other}")),
        }
    }
    let root = root.ok_or("usage: test-bridge --serve <dir> [--port <n>] [--conf <tauri.conf.json>]")?;
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot open {}: {e}", root.display()))?;
    let text = std::fs::read_to_string(&conf).map_err(|e| format!("cannot read {}: {e}", conf.display()))?;
    let json: Value = serde_json::from_str(&text).map_err(|e| format!("bad {}: {e}", conf.display()))?;
    let csp = json["app"]["security"]["csp"]
        .as_str()
        .ok_or("no app.security.csp in the config")?
        .to_string();
    Ok(Config { root, port, csp })
}

/// Decodes %XX escapes in a URL path; None when the escape is malformed or the result is not UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The Content-Type for a file name (only the kinds the built UI contains).
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "text/plain; charset=utf-8",
    }
}

/// A header from two literals (cannot fail for the fixed values used here).
fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap_or_else(|()| unreachable!("header literals are valid"))
}

/// Maps a URL path to a file under `root`, or the HTTP status to refuse with. Never leaves `root`.
fn resolve(root: &Path, url_path: &str) -> Result<PathBuf, u16> {
    let decoded = percent_decode(url_path).ok_or(400u16)?;
    if decoded.contains('\0') || decoded.contains('\\') || decoded.split('/').any(|seg| seg == "..") {
        return Err(403);
    }
    let rel = decoded.trim_start_matches('/');
    let candidate = root.join(if rel.is_empty() { "index.html" } else { rel });
    let real = candidate.canonicalize().map_err(|_| 404u16)?;
    if !real.starts_with(root) {
        return Err(403);
    }
    if real.is_file() { Ok(real) } else { Err(404) }
}

/// Serves one static file with the production CSP.
fn serve_file(request: Request, cfg: &Config) {
    let url = request.url().to_string();
    let path_part = url.split(['?', '#']).next().unwrap_or("/");
    if path_part == "/favicon.ico" {
        let _ = request.respond(Response::empty(StatusCode(204))); // the app window never asks; Chrome does, and a 404 would show up as a console error
        return;
    }
    let reply = match resolve(&cfg.root, path_part) {
        Ok(file) => match std::fs::File::open(&file) {
            Ok(f) => {
                let r = Response::from_file(f).with_header(header("Content-Type", content_type(&file)));
                request.respond(
                    r.with_header(header("Content-Security-Policy", &cfg.csp))
                        .with_header(header("X-Content-Type-Options", "nosniff"))
                        .with_header(header("Cache-Control", "no-store")),
                )
            }
            Err(_) => request.respond(Response::empty(StatusCode(404))),
        },
        Err(status) => request.respond(Response::empty(StatusCode(status))),
    };
    let _ = reply; // the browser may have gone away; nothing to do
}

/// A reader over the messages a job thread produces (blocks until the next message or the end).
struct Stream {
    rx: Receiver<Vec<u8>>,
    current: Vec<u8>,
    pos: usize,
}

impl Read for Stream {
    /// Hands out the current message, fetching the next one when it is used up; Ok(0) once the sender is gone.
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.current.len() {
            match self.rx.recv() {
                Ok(next) => {
                    self.current = next;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.current.len() - self.pos);
        out[..n].copy_from_slice(&self.current[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Encodes one reply message.
fn message(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(payload.len() + 5);
    m.push(kind);
    m.extend_from_slice(&u32::try_from(payload.len()).unwrap_or(u32::MAX).to_le_bytes());
    m.extend_from_slice(payload);
    m
}

/// Sends the final message of a JSON job (the result, or the error).
fn finish_json<T: serde::Serialize>(tx: &Sender<Vec<u8>>, result: Result<T, JobError>) {
    let m = match result.and_then(|v| serde_json::to_vec(&v).map_err(|e| JobError::new("internal", e.to_string()))) {
        Ok(json) => message(b'J', &json),
        Err(e) => message(b'E', &serde_json::to_vec(&e).unwrap_or_default()),
    };
    let _ = tx.send(m); // the page may have navigated away; then nobody is listening
}

/// Sends the final message of a binary job (a result frame, or the error).
fn finish_binary(tx: &Sender<Vec<u8>>, result: Result<Vec<u8>, JobError>) {
    let m = match result {
        Ok(bytes) => message(b'B', &bytes),
        Err(e) => message(b'E', &serde_json::to_vec(&e).unwrap_or_default()),
    };
    let _ = tx.send(m);
}

/// Progress callback that tells the page at most once per percent (and always 100%), like the app.
fn progress_sender(tx: Sender<Vec<u8>>) -> impl FnMut(f64) {
    let mut last = 0.0;
    move |fraction| {
        if fraction - last >= 0.01 || fraction >= 1.0 {
            last = fraction;
            let _ = tx.send(message(b'P', format!(r#"{{"fraction":{fraction}}}"#).as_bytes()));
        }
    }
}

/// Runs `work` on its own thread and returns the reply stream. A `tracked` job (the long ones) is registered so it can be cancelled and
/// counted, and may be held by the test hook; a short calculation is neither.
fn run_thread(
    jobs: &Jobs,
    job_id: u64,
    tracked: bool,
    work: impl FnOnce(Arc<AtomicBool>, Sender<Vec<u8>>) + Send + 'static,
) -> Stream {
    let (tx, rx) = channel::<Vec<u8>>();
    let cancel = if tracked {
        jobs.register(job_id)
    } else {
        Arc::new(AtomicBool::new(false))
    };
    let jobs = jobs.clone();
    std::thread::spawn(move || {
        while tracked && HOLD_JOBS.load(Ordering::Relaxed) && !cancel.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = tx.send(message(
                b'E',
                &serde_json::to_vec(&JobError::cancelled()).unwrap_or_default(),
            ));
        } else {
            work(cancel, tx);
        }
        if tracked {
            jobs.finish(job_id);
        }
    });
    Stream {
        rx,
        current: Vec::new(),
        pos: 0,
    }
}

/// A stream holding one ready message.
fn immediate(m: Vec<u8>) -> Stream {
    let (tx, rx) = channel();
    let _ = tx.send(m);
    Stream {
        rx,
        current: Vec::new(),
        pos: 0,
    }
}

/// Runs one command and returns the reply stream. A request that does not parse is answered with an error message.
fn invoke(jobs: &Jobs, cancels: &AtomicUsize, command: &str, mut args: Value) -> Stream {
    let job_id = args["jobId"].as_u64().unwrap_or(0);
    let request = args["request"].take();
    let refuse = |e: JobError| immediate(message(b'E', &serde_json::to_vec(&e).unwrap_or_default()));
    match command {
        "align_pair" => match parse_request::<AlignRequestDto>(request) {
            Ok(req) => run_thread(jobs, job_id, true, move |cancel, tx| {
                finish_binary(&tx, run_align(&req, &cancel, &mut progress_sender(tx.clone())))
            }),
            Err(e) => refuse(e),
        },
        "distance_matrix" => match parse_request::<DistancesRequestDto>(request) {
            Ok(req) => run_thread(jobs, job_id, true, move |cancel, tx| {
                finish_binary(&tx, run_distances(&req, &cancel, &mut progress_sender(tx.clone())))
            }),
            Err(e) => refuse(e),
        },
        "shuffle_test" => match parse_request::<ShuffleRequestDto>(request) {
            Ok(req) => run_thread(jobs, job_id, true, move |cancel, tx| {
                finish_json(&tx, run_shuffle(&req, &cancel, &mut progress_sender(tx.clone())))
            }),
            Err(e) => refuse(e),
        },
        "bootstrap_job" => match parse_request::<BootstrapRequestDto>(request) {
            Ok(req) => run_thread(jobs, job_id, true, move |cancel, tx| {
                finish_json(&tx, run_bootstrap(&req, &cancel, &mut progress_sender(tx.clone())))
            }),
            Err(e) => refuse(e),
        },
        "msa_job" => match parse_request::<MsaRequestDto>(request) {
            Ok(req) => run_thread(jobs, job_id, true, move |cancel, tx| {
                finish_json(&tx, run_msa(&req, &cancel, &mut progress_sender(tx.clone())))
            }),
            Err(e) => refuse(e),
        },
        "bio_op" => match parse_request::<OpRequest>(request) {
            Ok(req) => run_thread(jobs, 0, false, move |_, tx| finish_json(&tx, run_op(req))),
            Err(e) => refuse(e),
        },
        "cancel_job" => {
            if jobs.cancel(job_id) {
                cancels.fetch_add(1, Ordering::Relaxed); // counted so a test can prove the page's Cancel reached a RUNNING job
            }
            immediate(message(b'J', b"null"))
        }
        "hold_jobs" | "release_jobs" => {
            HOLD_JOBS.store(command == "hold_jobs", Ordering::Relaxed);
            immediate(message(b'J', b"null"))
        }
        "effective_cancels" => immediate(message(b'J', cancels.load(Ordering::Relaxed).to_string().as_bytes())),
        "active_jobs" => immediate(message(b'J', jobs.active().to_string().as_bytes())),
        other => refuse(JobError::new("invalid-argument", format!("Unknown command {other}"))),
    }
}

/// Handles one POST /invoke/<command> request.
fn serve_invoke(mut request: Request, jobs: &Jobs, cancels: &AtomicUsize) {
    let command = request
        .url()
        .trim_start_matches("/invoke/")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();
    let mut body = Vec::new();
    if request.as_reader().take(MAX_BODY).read_to_end(&mut body).is_err() {
        let _ = request.respond(Response::empty(StatusCode(400)));
        return;
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        let _ = request.respond(Response::empty(StatusCode(400)));
        return;
    };
    let stream = invoke(jobs, cancels, &command, parsed["args"].clone());
    let response = Response::new(
        StatusCode(200),
        vec![
            header("Content-Type", "application/octet-stream"),
            header("Cache-Control", "no-store"),
        ],
        stream,
        None,
        None,
    );
    let _ = request.respond(response); // fails only if the browser went away mid-reply
}

/// True when the Host header names this machine's loopback address (anything else could be a DNS-rebinding attempt).
fn host_ok(request: &Request) -> bool {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Host"))
        .is_some_and(|h| {
            let v = h.value.as_str();
            v.starts_with("127.0.0.1:") || v.starts_with("localhost:") || v == "127.0.0.1" || v == "localhost"
        })
}

/// Starts the server and answers requests until the process is stopped.
fn main() {
    let cfg = match parse_args() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("test-bridge: {e}");
            std::process::exit(2);
        }
    };
    let server = match Server::http(("127.0.0.1", cfg.port)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("test-bridge: cannot listen: {e}");
            std::process::exit(1);
        }
    };
    let port = server.server_addr().to_ip().map_or(cfg.port, |a| a.port());
    println!("LISTENING http://127.0.0.1:{port}");
    let _ = std::io::stdout().flush();
    let jobs = Jobs::default();
    let cancels = Arc::new(AtomicUsize::new(0));
    for request in server.incoming_requests() {
        let (cfg, jobs, cancels) = (Arc::clone(&cfg), jobs.clone(), Arc::clone(&cancels));
        std::thread::spawn(move || {
            if !host_ok(&request) {
                let _ = request.respond(Response::empty(StatusCode(403)));
            } else if *request.method() == Method::Post && request.url().starts_with("/invoke/") {
                serve_invoke(request, &jobs, &cancels);
            } else if *request.method() == Method::Get {
                serve_file(request, &cfg);
            } else {
                let _ = request.respond(Response::empty(StatusCode(405)));
            }
        });
    }
}
