//! Result shapes sent back to the web page. They serialize to EXACTLY the JSON the TypeScript types in
//! `src/shared/types.ts` describe (`{ ok: true, ... }` / `{ ok: false, reason, message }`), so the UI needs no changes.
//! Commands never return an error to the page for expected problems; they return a failed result instead.

use serde::Serialize;

/// Result of the "open file" command: the text, a cancel, or a typed failure.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum OpenFileResult {
    Opened {
        ok: bool,
        name: String,
        text: String,
    },
    Cancelled {
        ok: bool,
        reason: &'static str,
    },
    Failed {
        ok: bool,
        reason: &'static str,
        message: String,
    },
}

impl OpenFileResult {
    /// Builds the success result.
    pub fn opened(name: String, text: String) -> Self {
        Self::Opened { ok: true, name, text }
    }
    /// Builds the "user closed the dialog" result.
    pub fn cancelled() -> Self {
        Self::Cancelled {
            ok: false,
            reason: "cancelled",
        }
    }
    /// Builds a failure; `reason` is one of "too-large", "read-error", "invalid-request" (matches the TS union).
    pub fn failed(reason: &'static str, message: impl Into<String>) -> Self {
        Self::Failed {
            ok: false,
            reason,
            message: message.into(),
        }
    }
}

/// Result of the "save file" command.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum SaveFileResult {
    Saved {
        ok: bool,
        path: String,
    },
    Cancelled {
        ok: bool,
        reason: &'static str,
    },
    Failed {
        ok: bool,
        reason: &'static str,
        message: String,
    },
}

impl SaveFileResult {
    /// Builds the success result carrying the path the user chose.
    pub fn saved(path: String) -> Self {
        Self::Saved { ok: true, path }
    }
    /// Builds the "user closed the dialog" result.
    pub fn cancelled() -> Self {
        Self::Cancelled {
            ok: false,
            reason: "cancelled",
        }
    }
    /// Builds a failure; `reason` is "write-error" or "invalid-request".
    pub fn failed(reason: &'static str, message: impl Into<String>) -> Self {
        Self::Failed {
            ok: false,
            reason,
            message: message.into(),
        }
    }
}

/// Result of "open external link" and "copy text" (both are just success or a message).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum SimpleResult {
    Done { ok: bool },
    Failed { ok: bool, message: String },
}

impl SimpleResult {
    /// Builds the success result.
    pub fn done() -> Self {
        Self::Done { ok: true }
    }
    /// Builds a failure with a human-readable message.
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed {
            ok: false,
            message: message.into(),
        }
    }
}

/// Facts shown on the About page: the Tauri version (`runtime`) and the system web view version (`webview`).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub runtime: String,
    pub webview: String,
    pub platform: String,
}
