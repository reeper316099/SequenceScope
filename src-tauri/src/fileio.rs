//! Reading and writing the files the user picked in a native dialog. The dialogs themselves live in commands.rs;
//! these functions take plain paths so they can be unit-tested without a window.

use crate::validate::{MAX_OPEN_FILE_BYTES, OpenKind, SaveEncoding, SaveRequest};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Why reading a picked file failed.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    /// File is over the size cap (carries the size in bytes that was seen).
    TooLarge(u64),
    /// The extension is not one the chosen kind allows.
    WrongType,
    /// Any operating-system error (message is safe to show).
    Io(String),
}

/// True if the path's extension (case-insensitive) is allowed for this kind of file.
pub fn extension_allowed(path: &Path, kind: OpenKind) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|ext| kind.extensions().contains(&ext.as_str()))
}

/// Formats a byte count as megabytes with one decimal, like the Electron message ("12.3 MB").
pub fn megabytes(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1_048_576.0)
}

/// Reads at most `max_bytes` of a UTF-8 text file. Returns (file name, text).
/// Invalid UTF-8 becomes U+FFFD and a leading byte-order mark is dropped, exactly like JavaScript's TextDecoder.
pub fn read_limited_text(path: &Path, max_bytes: u64) -> Result<(String, String), ReadError> {
    let io = |e: std::io::Error| ReadError::Io(e.to_string());
    let size = std::fs::metadata(path).map_err(io)?.len();
    if size > max_bytes {
        return Err(ReadError::TooLarge(size));
    }
    // Read one byte past the cap so a file that grows after the check above is still caught.
    let mut buf = Vec::new();
    File::open(path)
        .map_err(io)?
        .take(max_bytes + 1)
        .read_to_end(&mut buf)
        .map_err(io)?;
    if buf.len() as u64 > max_bytes {
        return Err(ReadError::TooLarge(buf.len() as u64));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let decoded = String::from_utf8_lossy(&buf);
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded).to_string();
    Ok((name, text))
}

/// Full open pipeline for a path the user picked: type check, then size-limited read.
pub fn open_picked_file(path: &Path, kind: OpenKind) -> Result<(String, String), ReadError> {
    if !extension_allowed(path, kind) {
        return Err(ReadError::WrongType);
    }
    read_limited_text(path, MAX_OPEN_FILE_BYTES)
}

/// Writes a validated save request to the path the user chose (base64 content is decoded to bytes first).
pub fn write_save(path: &Path, req: &SaveRequest) -> Result<(), String> {
    match req.encoding {
        SaveEncoding::Utf8 => std::fs::write(path, req.content.as_bytes()).map_err(|e| e.to_string()),
        SaveEncoding::Base64 => {
            let bytes = STANDARD
                .decode(req.content.as_bytes())
                .map_err(|_| "The content is not valid base64.".to_string())?;
            std::fs::write(path, bytes).map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Makes a unique temp directory for one test and returns it (cleaned up by the test).
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sequencescope-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir"); // test code
        dir
    }

    #[test]
    fn extension_check_is_case_insensitive_and_kind_specific() {
        assert!(extension_allowed(Path::new("/x/a.FASTA"), OpenKind::Fasta));
        assert!(extension_allowed(Path::new("/x/a.txt"), OpenKind::Newick));
        assert!(extension_allowed(Path::new("/x/p.sscope"), OpenKind::Project));
        assert!(!extension_allowed(Path::new("/x/a.exe"), OpenKind::Fasta));
        assert!(!extension_allowed(Path::new("/x/a"), OpenKind::Fasta));
        assert!(!extension_allowed(Path::new("/x/a.nwk"), OpenKind::Fasta));
        assert!(
            !extension_allowed(Path::new("/x/.fasta"), OpenKind::Fasta),
            "a dotfile has no extension"
        );
    }

    #[test]
    fn reads_text_strips_bom_and_replaces_invalid_utf8() {
        let dir = temp_dir("read");
        let p = dir.join("a.fasta");
        std::fs::write(&p, b"\xEF\xBB\xBF>s1\nACGT\n").expect("write"); // test code
        assert_eq!(
            read_limited_text(&p, 1000),
            Ok(("a.fasta".to_string(), ">s1\nACGT\n".to_string()))
        );
        std::fs::write(&p, b">s\xFF1\n").expect("write"); // test code
        let (_, text) = read_limited_text(&p, 1000).expect("read"); // test code
        assert_eq!(text, ">s\u{FFFD}1\n");
        std::fs::remove_dir_all(dir).expect("cleanup"); // test code
    }

    #[test]
    fn size_cap_is_exact() {
        let dir = temp_dir("cap");
        let p = dir.join("a.fasta");
        std::fs::write(&p, vec![b'A'; 100]).expect("write"); // test code
        assert!(read_limited_text(&p, 100).is_ok(), "exactly at the cap is allowed");
        assert_eq!(read_limited_text(&p, 99), Err(ReadError::TooLarge(100)));
        std::fs::remove_dir_all(dir).expect("cleanup"); // test code
    }

    #[test]
    fn missing_file_is_an_io_error_not_a_crash() {
        assert!(matches!(
            read_limited_text(Path::new("/definitely/not/here.fasta"), 10),
            Err(ReadError::Io(_))
        ));
    }

    #[test]
    fn open_pipeline_rejects_wrong_type_before_reading() {
        let dir = temp_dir("type");
        let p = dir.join("a.exe");
        std::fs::write(&p, b"MZ").expect("write"); // test code
        assert_eq!(open_picked_file(&p, OpenKind::Fasta), Err(ReadError::WrongType));
        std::fs::remove_dir_all(dir).expect("cleanup"); // test code
    }

    #[test]
    fn megabytes_formats_like_the_electron_message() {
        assert_eq!(megabytes(10 * 1024 * 1024), "10.0");
        assert_eq!(megabytes(12_897_485), "12.3");
    }

    #[test]
    fn saves_utf8_and_base64() {
        let dir = temp_dir("save");
        let utf8 = SaveRequest {
            suggested_name: "a.txt".into(),
            extensions: vec!["txt".into()],
            content: "héllo".into(),
            encoding: SaveEncoding::Utf8,
        };
        let p1 = dir.join("a.txt");
        write_save(&p1, &utf8).expect("save utf8"); // test code
        assert_eq!(std::fs::read(&p1).expect("read"), "héllo".as_bytes()); // test code
        let b64 = SaveRequest {
            suggested_name: "a.png".into(),
            extensions: vec!["png".into()],
            content: "iVBORw0KGgo=".into(),
            encoding: SaveEncoding::Base64,
        };
        let p2 = dir.join("a.png");
        write_save(&p2, &b64).expect("save base64"); // test code
        assert_eq!(
            std::fs::read(&p2).expect("read"),
            [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        ); // test code
        let bad = SaveRequest {
            content: "!!!not base64!!!".into(),
            ..b64
        };
        assert!(write_save(&dir.join("b.png"), &bad).is_err());
        assert!(
            !dir.join("b.png").exists(),
            "nothing is written when the content is invalid"
        );
        std::fs::remove_dir_all(dir).expect("cleanup"); // test code
    }
}
