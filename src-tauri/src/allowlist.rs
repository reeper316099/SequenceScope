//! Which links the app may open in the system browser, and which pages the web view may navigate to.
//! The links the app may open: the same three hosts as the Electron version had, https only, no embedded credentials.

use url::Url;

/// Hostnames the "open external link" command may open. Keep this tiny; every entry is a deliberate decision.
pub const EXTERNAL_HOST_ALLOWLIST: [&str; 3] = ["github.com", "www.ncbi.nlm.nih.gov", "www.uniprot.org"];

/// True only for https URLs whose host is exactly on the allowlist (no subdomain tricks, no credentials).
pub fn is_allowed_external_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| EXTERNAL_HOST_ALLOWLIST.contains(&host))
}

/// True for the pages that make up the app itself. Anything else the web view tries to navigate to is blocked.
/// `tauri://localhost` (macOS/Linux) and `http(s)://tauri.localhost` (Windows) are the bundled app; the Vite dev
/// server is allowed in debug builds only.
pub fn is_app_url(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        ("http", Some("localhost" | "127.0.0.1")) => cfg!(debug_assertions),
        ("about", _) => url.as_str() == "about:blank",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_exact_allowlisted_https_hosts() {
        assert!(is_allowed_external_url("https://github.com/reeper316099/SequenceScope"));
        assert!(is_allowed_external_url(
            "https://www.ncbi.nlm.nih.gov/nuccore/NM_000518"
        ));
        assert!(is_allowed_external_url("https://www.uniprot.org/uniprotkb/P69905"));
    }

    // Same rejected inputs as tests/unit/appPath.test.ts, plus a few extra tricks.
    #[test]
    fn rejects_everything_else() {
        for bad in [
            "http://github.com/x",
            "https://evil.com",
            "https://github.com.evil.com",
            "https://user:pw@github.com/",
            "https://user@github.com/",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "not a url",
            "https://sub.github.com",
            "https://evilgithub.com",
            "https://github.com@evil.com/",
            "",
            "//github.com",
            "ftp://github.com/x",
        ] {
            assert!(!is_allowed_external_url(bad), "{bad} should be rejected");
        }
    }

    #[test]
    fn host_matching_is_case_insensitive_like_a_browser() {
        assert!(
            is_allowed_external_url("https://GitHub.COM/x"),
            "the URL parser lowercases hosts, same as JavaScript's URL"
        );
    }

    #[test]
    fn app_urls_are_only_the_bundled_app() {
        for ok in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/x",
            "about:blank",
        ] {
            assert!(is_app_url(&Url::parse(ok).expect("test URL parses")), "{ok}"); // test code: a bad literal is a test bug
        }
        for bad in [
            "https://github.com/",
            "tauri://evil/",
            "http://tauri.localhost.evil.com/",
            "file:///etc/passwd",
            "data:text/html,hi",
            "about:srcdoc",
            "javascript:1",
        ] {
            assert!(!is_app_url(&Url::parse(bad).expect("test URL parses")), "{bad}");
        }
    }

    #[test]
    fn dev_server_is_allowed_only_in_debug_builds() {
        let dev = Url::parse("http://localhost:5174/").expect("test URL parses");
        assert_eq!(is_app_url(&dev), cfg!(debug_assertions));
    }
}
