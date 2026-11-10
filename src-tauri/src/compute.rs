//! The long-running commands: alignment and the shuffle significance test. The real work is done by the core crate; this
//! file validates the request, runs it on a worker thread (the page stays responsive), reports progress, honours
//! cancellation, and shapes the result. `run_align` / `run_shuffle` are plain functions (no window needed) so they are
//! unit-tested directly; the `#[tauri::command]` functions below only connect them to the page.

use crate::dto::{
    AlignHeaderDto, AlignRequestDto, AlignmentDto, DpMetaDto, ProgressDto, ShuffleRequestDto, ShuffleSummaryDto,
    TimingsDto, parse_alphabet, parse_mode, parse_request,
};
use crate::frame::{Table, encode_frame};
use crate::jobs::{JobError, Jobs};
use sequencescope_core::pairwise::{Dp, Tables, fill_matrix_cancellable, traceback_all, traceback_first};
use sequencescope_core::scoring::compile_scoring;
use sequencescope_core::shuffle::{ShuffleOptions, ShuffleOutcome, run_shuffle_test};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::State;
use tauri::ipc::{Channel, Response};

/// Runs one alignment and returns the binary result frame (JSON header + DP tables, see frame.rs). `progress` is called
/// after every DP row; the job stops with a "cancelled" error as soon as `cancel` becomes true.
pub fn run_align(
    req: &AlignRequestDto,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f64),
) -> Result<Vec<u8>, JobError> {
    let alphabet = parse_alphabet(&req.alphabet)?;
    let mode = parse_mode(&req.mode)?;
    let scoring = compile_scoring(&req.scoring.to_core()?, alphabet)?;
    let started = Instant::now();
    let dp = fill_matrix_cancellable(&req.a, &req.b, mode, &scoring, &mut |fraction| {
        progress(fraction);
        !cancel.load(Ordering::Relaxed)
    })?
    .ok_or_else(JobError::cancelled)?;
    let fill_ms = started.elapsed().as_secs_f64() * 1000.0;
    if cancel.load(Ordering::Relaxed) {
        return Err(JobError::cancelled());
    }
    let started = Instant::now();
    let first = traceback_first(&dp);
    let all = traceback_all(&dp, req.cap()?)?; // the cap is checked after the fill, like the TypeScript worker
    let traceback_ms = started.elapsed().as_secs_f64() * 1000.0;

    let Dp {
        mode,
        rows,
        cols,
        score,
        ends,
        tables,
        ..
    } = dp;
    let (kind, tables): (&'static str, Vec<Table>) = match tables {
        Tables::Linear { h, p } => ("linear", vec![Table::I32(b'H', h), Table::U8(b'P', p)]),
        Tables::Affine { m, x, y, p } => (
            "affine",
            vec![
                Table::I32(b'M', m),
                Table::I32(b'X', x),
                Table::I32(b'Y', y),
                Table::U16(b'P', p),
            ],
        ),
    };
    let header = AlignHeaderDto {
        alignment: AlignmentDto::from(&first),
        all: all.alignments.iter().map(AlignmentDto::from).collect(),
        capped: all.capped,
        dp: DpMetaDto {
            kind,
            mode: mode.as_str(),
            rows,
            cols,
            score,
            ends,
        },
        timings: TimingsDto { fill_ms, traceback_ms },
    };
    let json = serde_json::to_vec(&header)
        .map_err(|e| JobError::new("internal", format!("Could not encode the result: {e}")))?;
    Ok(encode_frame(&json, tables))
}

/// Runs the shuffle significance test. `progress` gets the completed fraction; the job stops when `cancel` becomes true.
pub fn run_shuffle(
    req: &ShuffleRequestDto,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f64),
) -> Result<ShuffleSummaryDto, JobError> {
    let alphabet = parse_alphabet(&req.alphabet)?;
    let mode = parse_mode(&req.mode)?;
    let scoring = compile_scoring(&req.scoring.to_core()?, alphabet)?;
    let (shuffles, seed) = req.counts()?;
    let opts = ShuffleOptions {
        a: &req.a,
        b: &req.b,
        mode,
        scoring: &scoring,
        shuffles,
        seed,
    };
    match run_shuffle_test(&opts, progress, &mut || cancel.load(Ordering::Relaxed))? {
        ShuffleOutcome::Done(summary) => Ok(summary.into()),
        ShuffleOutcome::Cancelled { .. } => Err(JobError::cancelled()),
    }
}

/// Sends progress to the page at most once per percent (and always the final 100%), like the TypeScript workers.
fn throttled(channel: Channel<ProgressDto>) -> impl FnMut(f64) {
    let mut last = 0.0;
    move |fraction| {
        if fraction - last >= 0.01 || fraction >= 1.0 {
            last = fraction;
            let _ = channel.send(ProgressDto { fraction }); // a closed window just means nobody is listening any more
        }
    }
}

/// Runs a closure on a worker thread without blocking the app's event loop, mapping a thread panic to an error.
async fn on_worker_thread<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, JobError> + Send + 'static,
) -> Result<T, JobError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| JobError::new("internal", format!("The job thread failed: {e}")))?
}

/// Aligns two sequences and returns the result as one binary frame. `job_id` lets the page cancel it with `cancel_job`.
#[tauri::command]
pub async fn align_pair(
    jobs: State<'_, Jobs>,
    job_id: u64,
    request: Value,
    on_progress: Channel<ProgressDto>,
) -> Result<Response, JobError> {
    let req: AlignRequestDto = parse_request(request)?;
    let cancel = jobs.register(job_id);
    let result = on_worker_thread(move || run_align(&req, &cancel, &mut throttled(on_progress))).await;
    jobs.finish(job_id);
    result.map(Response::new)
}

/// Runs the shuffle significance test and returns its summary as JSON.
#[tauri::command]
pub async fn shuffle_test(
    jobs: State<'_, Jobs>,
    job_id: u64,
    request: Value,
    on_progress: Channel<ProgressDto>,
) -> Result<ShuffleSummaryDto, JobError> {
    let req: ShuffleRequestDto = parse_request(request)?;
    let cancel = jobs.register(job_id);
    let result = on_worker_thread(move || run_shuffle(&req, &cancel, &mut throttled(on_progress))).await;
    jobs.finish(job_id);
    result
}

/// Asks a running job to stop. Safe to call for a job that already finished.
#[tauri::command]
pub fn cancel_job(jobs: State<'_, Jobs>, job_id: u64) {
    jobs.cancel(job_id);
}

/// Smoke tests only: how many jobs are running (refuses outside smoke mode).
#[tauri::command]
pub fn smoke_active_jobs(jobs: State<'_, Jobs>) -> Result<usize, String> {
    if !crate::smoke::enabled() {
        return Err("smoke mode is off".to_string());
    }
    Ok(jobs.active())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn align_req(a: &str, b: &str, mode: &str, scoring: Value, cap: u32) -> AlignRequestDto {
        parse_request(json!({ "type": "align", "a": a, "b": b, "alphabet": "dna", "mode": mode, "scoring": scoring, "enumerateCap": cap })).expect("valid request") // test code
    }
    fn affine_dna() -> Value {
        json!({ "substitution": { "kind": "simple", "match": 2, "mismatch": -3 }, "gaps": { "kind": "affine", "open": 5, "extend": 1 } })
    }
    fn linear_dna() -> Value {
        json!({ "substitution": { "kind": "simple", "match": 1, "mismatch": -1 }, "gaps": { "kind": "linear", "gap": 1 } })
    }

    /// Splits a frame into its JSON header (as a Value) and the number of tables (layout in frame.rs).
    fn header_of(frame: &[u8]) -> (Value, usize) {
        let u32_at = |o: usize| u32::from_le_bytes([frame[o], frame[o + 1], frame[o + 2], frame[o + 3]]) as usize;
        let (json_len, count) = (u32_at(4), u32_at(8));
        let start = 16 + 16 * count;
        (
            serde_json::from_slice(&frame[start..start + json_len]).expect("json header"),
            count,
        ) // test code
    }

    #[test]
    fn global_affine_alignment_frame_matches_the_core_crate() {
        let req = align_req("GCATGCG", "GATTACA", "global", affine_dna(), 1000);
        let frame = run_align(&req, &AtomicBool::new(false), &mut |_| {}).expect("aligns"); // test code
        let (header, tables) = header_of(&frame);
        assert_eq!(tables, 4, "M, X, Y, P");
        let scoring = compile_scoring(
            &req.scoring.to_core().expect("scoring"),
            sequencescope_core::types::Alphabet::Dna,
        )
        .expect("compiled"); // test code
        let expected = sequencescope_core::pairwise::align(
            "GCATGCG",
            "GATTACA",
            sequencescope_core::types::AlignMode::Global,
            &scoring,
        )
        .expect("align"); // test code
        assert_eq!(header["alignment"]["rowA"], expected.row_a);
        assert_eq!(header["alignment"]["rowB"], expected.row_b);
        assert_eq!(header["alignment"]["score"], expected.score);
        assert_eq!(header["dp"]["kind"], "affine");
        assert_eq!(
            (header["dp"]["rows"].as_u64(), header["dp"]["cols"].as_u64()),
            (Some(8), Some(8))
        );
        assert_eq!(
            header["all"][0], header["alignment"],
            "the first enumerated alignment is the deterministic one"
        );
        assert!(header["timings"]["fillMs"].as_f64().is_some());
    }

    #[test]
    fn linear_alignment_has_two_tables() {
        let frame = run_align(
            &align_req("ACGT", "ACGT", "local", linear_dna(), 10),
            &AtomicBool::new(false),
            &mut |_| {},
        )
        .expect("aligns"); // test code
        let (header, tables) = header_of(&frame);
        assert_eq!((tables, header["dp"]["kind"].as_str()), (2, Some("linear")));
        assert_eq!(header["alignment"]["score"], 4);
    }

    #[test]
    fn progress_is_reported_per_row_and_ends_at_one() {
        let mut seen = Vec::new();
        run_align(
            &align_req("ACGTACGT", "ACGT", "global", linear_dna(), 10),
            &AtomicBool::new(false),
            &mut |f| seen.push(f),
        )
        .expect("aligns"); // test code
        assert_eq!(seen.len(), 8);
        assert_eq!(seen.last(), Some(&1.0));
        assert!(seen.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn a_cancelled_alignment_stops_and_reports_cancelled() {
        let cancel = AtomicBool::new(false);
        let mut rows = 0;
        let r = run_align(
            &align_req(&"ACGT".repeat(50), &"ACGT".repeat(50), "global", affine_dna(), 10),
            &cancel,
            &mut |_| {
                rows += 1;
                if rows == 3 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );
        assert_eq!(r.expect_err("cancelled").code, "cancelled");
        assert!(
            rows <= 4,
            "the fill stopped within a row of the cancel request ({rows} rows ran)"
        );
    }

    #[test]
    fn errors_keep_the_core_codes_and_messages() {
        let bad_residue = run_align(
            &align_req("ACGT", "AC#T", "global", linear_dna(), 10),
            &AtomicBool::new(false),
            &mut |_| {},
        );
        let e = bad_residue.expect_err("bad residue"); // test code
        assert_eq!(e.code, "invalid-residue");
        assert!(e.message.contains("position 3"));
        let big = run_align(
            &align_req(&"A".repeat(5001), &"A".repeat(5001), "global", linear_dna(), 10),
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert_eq!(big.expect_err("too large").code, "too-large");
        let bad_cap = run_align(
            &align_req("AC", "AC", "global", linear_dna(), 0),
            &AtomicBool::new(false),
            &mut |_| {},
        );
        assert_eq!(
            bad_cap.expect_err("cap 0").message,
            "Enumeration cap must be a positive integer."
        );
    }

    fn shuffle_req(shuffles: u32, seed: u32) -> ShuffleRequestDto {
        parse_request(json!({ "type": "shuffle", "a": "ACGTACGTAC", "b": "ACGGACGTTC", "alphabet": "dna", "mode": "local", "scoring": affine_dna(), "shuffles": shuffles, "seed": seed })).expect("valid request") // test code
    }

    #[test]
    fn shuffle_test_is_deterministic_and_reports_progress() {
        let mut seen = Vec::new();
        let a = run_shuffle(&shuffle_req(20, 7), &AtomicBool::new(false), &mut |f| seen.push(f)).expect("runs"); // test code
        let b = run_shuffle(&shuffle_req(20, 7), &AtomicBool::new(false), &mut |_| {}).expect("runs"); // test code
        assert_eq!(a, b);
        assert_eq!((a.shuffles, a.scores.len(), seen.len()), (20, 20, 20));
        assert_eq!(seen.last(), Some(&1.0));
    }

    #[test]
    fn a_cancelled_shuffle_test_reports_cancelled() {
        let cancel = AtomicBool::new(true);
        assert_eq!(
            run_shuffle(&shuffle_req(50, 1), &cancel, &mut |_| {})
                .expect_err("cancelled")
                .code,
            "cancelled"
        );
    }

    #[test]
    fn invalid_shuffle_requests_are_rejected_with_core_codes() {
        let e = run_shuffle(&shuffle_req(0, 1), &AtomicBool::new(false), &mut |_| {}).expect_err("zero shuffles"); // test code
        assert_eq!(e.code, "invalid-argument");
        assert!(e.message.contains("1 to 5000"));
    }
}
