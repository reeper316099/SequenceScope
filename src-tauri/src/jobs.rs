//! Running-job registry. Every long computation (an alignment, a shuffle test) gets a job id chosen by the page. The
//! registry holds one cancel flag per running job; `cancel_job` sets it, and the computation polls it between rows /
//! shuffles and stops. Jobs remove themselves when they finish, so the registry only ever holds running work.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// Shared registry of running jobs (cheap to clone; all clones see the same map).
#[derive(Debug, Default, Clone)]
pub struct Jobs {
    running: Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>>,
}

impl Jobs {
    /// Locks the map; a panic in another thread must not stop cancellation from working, so poisoning is ignored.
    fn map(&self) -> MutexGuard<'_, HashMap<u64, Arc<AtomicBool>>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a job and returns its cancel flag (a job id that is already running is replaced).
    pub fn register(&self, id: u64) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.map().insert(id, Arc::clone(&flag));
        flag
    }

    /// Removes a finished job (does nothing for an unknown id).
    pub fn finish(&self, id: u64) {
        self.map().remove(&id);
    }

    /// Asks a running job to stop; returns false if no such job is running (already finished, or never started).
    pub fn cancel(&self, id: u64) -> bool {
        match self.map().get(&id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Number of jobs currently running (used by the smoke test to prove a cancelled job really stopped).
    pub fn active(&self) -> usize {
        self.map().len()
    }
}

/// The error a job command returns to the page: a machine-readable code plus a message. The code is the `BioErrorCode`
/// string, "cancelled" for a stopped job, or "internal" for a bug.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

impl JobError {
    /// An error with the given code and message.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    /// The job was cancelled by the page.
    pub fn cancelled() -> Self {
        Self::new("cancelled", "The job was cancelled.")
    }
}

impl From<sequencescope_core::error::BioError> for JobError {
    /// Keeps the core error code and message unchanged so the UI shows the same text as with the TypeScript backend.
    fn from(e: sequencescope_core::error::BioError) -> Self {
        Self {
            code: e.code.as_str().to_string(),
            message: e.message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_cancel_finish_cycle() {
        let jobs = Jobs::default();
        let flag = jobs.register(7);
        assert_eq!(jobs.active(), 1);
        assert!(!flag.load(Ordering::Relaxed));
        assert!(jobs.cancel(7));
        assert!(flag.load(Ordering::Relaxed));
        jobs.finish(7);
        assert_eq!(jobs.active(), 0);
        assert!(!jobs.cancel(7), "cancelling a finished job does nothing");
        jobs.finish(7); // finishing twice is harmless
    }

    #[test]
    fn cancelling_one_job_does_not_touch_another() {
        let jobs = Jobs::default();
        let (a, b) = (jobs.register(1), jobs.register(2));
        jobs.cancel(1);
        assert!(a.load(Ordering::Relaxed) && !b.load(Ordering::Relaxed));
    }

    #[test]
    fn clones_share_the_same_registry() {
        let jobs = Jobs::default();
        let other = jobs.clone();
        let flag = jobs.register(5);
        other.cancel(5);
        assert!(flag.load(Ordering::Relaxed));
    }

    #[test]
    fn bio_errors_keep_their_code_and_message() {
        let e: JobError =
            sequencescope_core::error::BioError::new(sequencescope_core::error::BioErrorCode::TooLarge, "big").into();
        assert_eq!(e, JobError::new("too-large", "big"));
    }
}
