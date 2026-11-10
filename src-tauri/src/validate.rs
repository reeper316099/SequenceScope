//! Request validation. Everything the web page sends is untrusted, so each command checks its input here BEFORE
//! doing anything. These rules are a line-by-line port of the zod schemas in `src/shared/schemas.ts`
//! (sizes there are JavaScript string lengths = UTF-16 code units, so we count the same way).

use serde::Deserialize;
use serde_json::Value;

/// Largest file the open dialog will read (same 10 MB cap as `MAX_OPEN_FILE_BYTES` in the TS code).
pub const MAX_OPEN_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// Largest content accepted by the save command (50 MB of string length).
pub const MAX_SAVE_CONTENT_LEN: usize = 50 * 1024 * 1024;
/// Largest text accepted by the clipboard command (5 MB of string length).
pub const MAX_COPY_TEXT_LEN: usize = 5 * 1024 * 1024;
/// Longest URL the external-link command will look at.
pub const MAX_URL_LEN: usize = 2048;

/// Kinds of file the open dialog can ask for; Rust owns the extension list for each kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenKind {
    Fasta,
    Newick,
    Project,
}

impl OpenKind {
    /// Parses the kind string sent by the page; anything else is rejected (None).
    pub fn parse(raw: &Value) -> Option<Self> {
        match raw.as_str()? {
            "fasta" => Some(Self::Fasta),
            "newick" => Some(Self::Newick),
            "project" => Some(Self::Project),
            _ => None,
        }
    }

    /// Dialog filter label shown to the user.
    pub fn label(self) -> &'static str {
        match self {
            Self::Fasta => "FASTA",
            Self::Newick => "Newick",
            Self::Project => "SequenceScope project",
        }
    }

    /// Allowed file extensions (the same lists the Electron version offered).
    pub fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Fasta => &["fasta", "fa", "faa", "fna", "fas", "txt"],
            Self::Newick => &["nwk", "newick", "tree", "tre", "txt"],
            Self::Project => &["json", "sscope"],
        }
    }
}

/// How the `content` of a save request is encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SaveEncoding {
    Utf8,
    Base64,
}

/// A validated save request (every field already checked).
#[derive(Debug, PartialEq, Eq)]
pub struct SaveRequest {
    pub suggested_name: String,
    pub extensions: Vec<String>,
    pub content: String,
    pub encoding: SaveEncoding,
}

/// Unvalidated shape of the save request as it arrives from JSON (camelCase like the TS side).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSaveRequest {
    suggested_name: String,
    extensions: Vec<String>,
    content: String,
    encoding: SaveEncoding,
}

/// Length of a string the way JavaScript counts it (UTF-16 code units), so limits match the zod schemas.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// True if the file name has at least one character and none of `/ \ : * ? " < > | NUL` (no path tricks).
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'))
}

/// True for 1-8 ASCII letters or digits (a file extension without the dot).
fn is_plain_extension(ext: &str) -> bool {
    (1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Checks and converts the raw JSON of a save request; the error text is safe to show the user.
pub fn parse_save_request(raw: &Value) -> Result<SaveRequest, String> {
    let req: RawSaveRequest = serde_json::from_value(raw.clone()).map_err(|_| "Invalid save request.".to_string())?;
    if !(1..=200).contains(&js_len(&req.suggested_name)) || !is_plain_file_name(&req.suggested_name) {
        return Err("Invalid save request.".to_string());
    }
    if !(1..=6).contains(&req.extensions.len()) || !req.extensions.iter().all(|e| is_plain_extension(e)) {
        return Err("Invalid save request.".to_string());
    }
    if js_len(&req.content) > MAX_SAVE_CONTENT_LEN {
        return Err("Invalid save request.".to_string());
    }
    Ok(SaveRequest {
        suggested_name: req.suggested_name,
        extensions: req.extensions,
        content: req.content,
        encoding: req.encoding,
    })
}

/// Accepts clipboard text only if it is a string of at most 5 MB.
pub fn parse_copy_text(raw: &Value) -> Option<String> {
    let text = raw.as_str()?;
    (js_len(text) <= MAX_COPY_TEXT_LEN).then(|| text.to_string())
}

/// Accepts a link only if it is a non-empty string of at most 2048 characters.
pub fn parse_external_url(raw: &Value) -> Option<String> {
    let url = raw.as_str()?;
    (1..=MAX_URL_LEN).contains(&js_len(url)).then(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok_req() -> Value {
        json!({ "suggestedName": "tree.nwk", "extensions": ["nwk"], "content": "(A,B);", "encoding": "utf8" })
    }

    #[test]
    fn open_kind_accepts_the_three_kinds_only() {
        assert_eq!(OpenKind::parse(&json!("fasta")), Some(OpenKind::Fasta));
        assert_eq!(OpenKind::parse(&json!("newick")), Some(OpenKind::Newick));
        assert_eq!(OpenKind::parse(&json!("project")), Some(OpenKind::Project));
        for bad in [
            json!("FASTA"),
            json!("exe"),
            json!(""),
            json!(3),
            json!(null),
            json!({ "kind": "fasta" }),
        ] {
            assert_eq!(OpenKind::parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn open_kind_extension_lists_match_the_electron_filters() {
        assert_eq!(
            OpenKind::Fasta.extensions(),
            ["fasta", "fa", "faa", "fna", "fas", "txt"]
        );
        assert_eq!(OpenKind::Newick.extensions(), ["nwk", "newick", "tree", "tre", "txt"]);
        assert_eq!(OpenKind::Project.extensions(), ["json", "sscope"]);
    }

    #[test]
    fn save_request_accepts_a_normal_request() {
        let r = parse_save_request(&ok_req()).expect("valid request"); // test code: a failure here is the test failing
        assert_eq!(r.suggested_name, "tree.nwk");
        assert_eq!(r.encoding, SaveEncoding::Utf8);
    }

    #[test]
    fn save_request_rejects_path_tricks_in_the_name() {
        for name in [
            "../x", "a/b", "a\\b", "C:x", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\0b", "",
        ] {
            let mut v = ok_req();
            v["suggestedName"] = json!(name);
            assert!(parse_save_request(&v).is_err(), "name {name:?} should be rejected");
        }
        let mut long = ok_req();
        long["suggestedName"] = json!("a".repeat(201));
        assert!(parse_save_request(&long).is_err());
        long["suggestedName"] = json!("a".repeat(200));
        assert!(parse_save_request(&long).is_ok());
    }

    #[test]
    fn save_request_rejects_bad_extensions() {
        for exts in [
            json!([]),
            json!(["n wk"]),
            json!(["nwk."]),
            json!(["verylongext"]),
            json!([""]),
            json!(["a", "b", "c", "d", "e", "f", "g"]),
            json!([1]),
        ] {
            let mut v = ok_req();
            v["extensions"] = exts.clone();
            assert!(parse_save_request(&v).is_err(), "extensions {exts} should be rejected");
        }
        let mut ok = ok_req();
        ok["extensions"] = json!(["PNG", "a1"]);
        assert!(parse_save_request(&ok).is_ok(), "uppercase and digits are fine");
    }

    #[test]
    fn save_request_rejects_unknown_encoding_missing_fields_and_wrong_types() {
        let mut v = ok_req();
        v["encoding"] = json!("latin1");
        assert!(parse_save_request(&v).is_err());
        assert!(parse_save_request(&json!({ "suggestedName": "a.txt" })).is_err());
        assert!(parse_save_request(&json!("hello")).is_err());
        assert!(parse_save_request(&Value::Null).is_err());
    }

    #[test]
    fn save_request_enforces_the_content_size_cap_in_utf16_units() {
        let mut v = ok_req();
        v["content"] = json!("x".repeat(MAX_SAVE_CONTENT_LEN));
        assert!(parse_save_request(&v).is_ok());
        v["content"] = json!("x".repeat(MAX_SAVE_CONTENT_LEN + 1));
        assert!(parse_save_request(&v).is_err());
        // An astral character is 2 UTF-16 units in JavaScript, so it counts double.
        v["content"] = json!(format!("{}{}", "x".repeat(MAX_SAVE_CONTENT_LEN - 1), "\u{1F9EC}"));
        assert!(parse_save_request(&v).is_err());
    }

    #[test]
    fn copy_text_is_capped_at_five_megabytes_of_length() {
        assert_eq!(parse_copy_text(&json!("(A,B);")), Some("(A,B);".to_string()));
        assert!(parse_copy_text(&json!("x".repeat(MAX_COPY_TEXT_LEN))).is_some());
        assert!(parse_copy_text(&json!("x".repeat(MAX_COPY_TEXT_LEN + 1))).is_none());
        assert!(parse_copy_text(&json!(5)).is_none());
    }

    #[test]
    fn external_url_length_rules() {
        assert!(parse_external_url(&json!("https://github.com")).is_some());
        assert!(parse_external_url(&json!("")).is_none());
        assert!(parse_external_url(&json!("h".repeat(MAX_URL_LEN + 1))).is_none());
        assert!(parse_external_url(&json!(null)).is_none());
    }
}
