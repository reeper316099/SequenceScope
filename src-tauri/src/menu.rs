//! The application menu (File / Edit / View / Help), the same items and shortcuts the Electron app had. A click does not run
//! anything itself: it asks the page to perform one of a FIXED list of commands (`menu-action` event), exactly like Electron.
//! Help links open only through the same https allowlist as the page's own `open_external`.

use crate::allowlist::is_allowed_external_url;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// The project page; the Help menu links are built from it.
const REPO_URL: &str = "https://github.com/reeper316099/SequenceScope";

/// One custom menu entry: the command sent to the page (also the menu item id), its label, and its shortcut.
pub struct Entry {
    pub action: &'static str,
    pub label: &'static str,
    pub accelerator: Option<&'static str>,
}

const fn entry(action: &'static str, label: &'static str, accelerator: Option<&'static str>) -> Entry {
    Entry {
        action,
        label,
        accelerator,
    }
}

/// File menu entries, in order.
pub const FILE: [Entry; 5] = [
    entry("open-fasta", "Open FASTA…", Some("CmdOrCtrl+O")),
    entry("open-newick", "Open Newick…", None),
    entry("open-project", "Open Project…", None),
    entry("save-project", "Save Project…", Some("CmdOrCtrl+S")),
    entry("export", "Export…", Some("CmdOrCtrl+E")),
];

/// Edit menu entries that the page handles itself (cut / copy / paste / select all are the system's).
pub const EDIT: [Entry; 2] = [
    entry("undo", "Undo", Some("CmdOrCtrl+Z")),
    entry("redo", "Redo", Some("CmdOrCtrl+Shift+Z")),
];

/// View menu: one entry per view (the page's views, in order), then the theme switch.
pub const VIEWS: [Entry; 7] = [
    entry("view-1", "Align", Some("CmdOrCtrl+1")),
    entry("view-2", "Distances", Some("CmdOrCtrl+2")),
    entry("view-3", "Trees", Some("CmdOrCtrl+3")),
    entry("view-4", "MSA", Some("CmdOrCtrl+4")),
    entry("view-5", "Examples", Some("CmdOrCtrl+5")),
    entry("view-6", "Learn", Some("CmdOrCtrl+6")),
    entry("view-7", "About", Some("CmdOrCtrl+7")),
];

/// The dark-mode entry of the View menu.
pub const THEME: Entry = entry("toggle-dark", "Toggle Dark Mode", Some("CmdOrCtrl+D"));

/// Help entries that open a link; the link is `REPO_URL` + the suffix.
const HELP_LINKS: [(&str, &str, &str); 3] = [
    ("help-repo", "GitHub Repository", ""),
    ("help-issues", "Report an Issue", "/issues"),
    ("help-sources", "Data Sources", "/blob/main/DATA-SOURCES.md"),
];

/// Every command the page may be asked to perform (what the menu can send).
pub fn all_actions() -> Vec<&'static str> {
    FILE.iter()
        .chain(EDIT.iter())
        .chain(VIEWS.iter())
        .chain(std::iter::once(&THEME))
        .map(|e| e.action)
        .collect()
}

/// Builds one menu item from a table entry.
fn item<R: Runtime>(app: &AppHandle<R>, e: &Entry) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(e.action, e.label);
    if let Some(a) = e.accelerator {
        b = b.accelerator(a);
    }
    b.build(app)
}

/// Builds the whole menu bar.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut file = SubmenuBuilder::new(app, "File");
    for e in &FILE {
        file = file.item(&item(app, e)?);
    }
    let file = file.separator().item(&PredefinedMenuItem::quit(app, None)?).build()?;

    let mut edit = SubmenuBuilder::new(app, "Edit");
    for e in &EDIT {
        edit = edit.item(&item(app, e)?);
    }
    let edit = edit
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let mut view = SubmenuBuilder::new(app, "View");
    for e in &VIEWS {
        view = view.item(&item(app, e)?);
    }
    let view = view.separator().item(&item(app, &THEME)?).build()?;

    let mut help = SubmenuBuilder::new(app, "Help").item(&item(app, &entry("view-7", "About SequenceScope", None))?);
    for (id, label, _) in HELP_LINKS {
        help = help.item(&MenuItemBuilder::with_id(id, label).build(app)?);
    }
    let help = help.build()?;

    let mut bar = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "SequenceScope")
            .item(&PredefinedMenuItem::about(app, None, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;
        bar = bar.item(&app_menu);
    }
    bar.item(&file).item(&edit).item(&view).item(&help).build()
}

/// The link a Help item opens, if `id` is one of the link items.
fn help_url(id: &str) -> Option<String> {
    HELP_LINKS
        .iter()
        .find(|(i, _, _)| *i == id)
        .map(|(_, _, suffix)| format!("{REPO_URL}{suffix}"))
}

/// Handles a click: a Help link opens (only if allowlisted); anything in the fixed command list goes to the page.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    let id = event.id().as_ref();
    if let Some(url) = help_url(id) {
        if is_allowed_external_url(&url) {
            let _ = app.opener().open_url(url, None::<&str>); // a failure to launch the browser has nobody to tell
        }
        return;
    }
    if !all_actions().contains(&id) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        // `id` is one of the constant strings above, never user data, so building the script from it is safe.
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('menu-action',{{detail:{id:?}}}))"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The command names the page accepts, read from the shared TypeScript list (so the two cannot drift apart).
    fn page_actions() -> Vec<String> {
        let ts = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/shared/types.ts"))
            .expect("types.ts is in the repository");
        let start = ts.find("export const MENU_ACTIONS = [").expect("MENU_ACTIONS exists");
        let end = ts[start..].find("] as const").expect("list ends") + start;
        ts[start..end]
            .split('\'')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn menu_can_send_exactly_the_commands_the_page_accepts() {
        let mut mine: Vec<String> = all_actions().into_iter().map(str::to_string).collect();
        let mut theirs = page_actions();
        mine.sort();
        theirs.sort();
        assert_eq!(mine, theirs);
    }

    #[test]
    fn shortcuts_are_unique() {
        let mut keys: Vec<&str> = FILE
            .iter()
            .chain(EDIT.iter())
            .chain(VIEWS.iter())
            .chain(std::iter::once(&THEME))
            .filter_map(|e| e.accelerator)
            .collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(before, keys.len());
    }

    #[test]
    fn help_links_are_on_the_https_allowlist() {
        for (id, _, _) in HELP_LINKS {
            let url = help_url(id).expect("link item");
            assert!(is_allowed_external_url(&url), "{url}");
        }
        assert_eq!(help_url("export"), None);
    }
}
