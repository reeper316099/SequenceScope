//! Newick parser and writer (ALGORITHMS.md section 9). Port of `src/bio/newick.ts`.
//!
//! Conventions:
//!  * Labels may be quoted with single quotes ('' is an escaped quote). Unquoted underscores are KEPT as underscores.
//!  * Branch lengths may use scientific notation (1e-3) and may be negative. A missing length stays None.
//!  * [bracketed comments] are skipped.
//!  * A numeric label on an internal node is read as a support value (node.support); any other internal label stays a label.
//!  * Only the first tree of a multi-tree file is returned; the number of extra trees is reported.
//!
//! The parser works on UTF-16 code units (not Rust chars), so error positions, lines, and columns are exactly the ones the
//! TypeScript reports, and numbers are written with `js_number_to_string` so the text is identical.

use crate::alphabet::is_js_whitespace;
use crate::error::{BioError, BioErrorCode};
use crate::jsnum::js_number_to_string;
use crate::tree::{Tree, TreeNode};

/// A syntax error with a 0-based position and 1-based line/column (the message already contains "(line L, column C).").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewickError {
    pub message: String,
    pub position: usize,
    pub line: usize,
    pub column: usize,
}

impl NewickError {
    /// An error at a 0-based UTF-16 offset in `text`.
    fn new(message: &str, text: &[u16], position: usize) -> Self {
        let before = &text[..position.min(text.len())];
        let line = before.iter().filter(|&&u| u == u16::from(b'\n')).count() + 1;
        let last_newline = before
            .iter()
            .rposition(|&u| u == u16::from(b'\n'))
            .map_or(-1, |p| p as i64);
        let column = (position as i64 - last_newline) as usize;
        Self {
            message: format!("{message} (line {line}, column {column})."),
            position,
            line,
            column,
        }
    }
}

impl From<NewickError> for BioError {
    /// Newick syntax errors become `newick-syntax` errors with the same message.
    fn from(e: NewickError) -> Self {
        BioError::new(BioErrorCode::NewickSyntax, e.message)
    }
}

/// The first tree plus the number of further trees found after it.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedNewick {
    pub tree: Tree,
    /// Additional trees found after the first one (ignored).
    pub extra_trees: usize,
}

const MAX_DEPTH: usize = 3000;

/// True for a UTF-16 unit that is JavaScript whitespace.
fn is_ws(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(is_js_whitespace)
}

/// True for a unit that ends an unquoted label: whitespace or one of ( ) [ ] ' , : ;
fn is_delim(u: u16) -> bool {
    is_ws(u) || matches!(u, 0x28 | 0x29 | 0x5B | 0x5D | 0x27 | 0x2C | 0x3A | 0x3B)
}

fn is_digit(u: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&u)
}

/// Length of the number starting at `i` according to `[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`, or None.
fn match_number(t: &[u16], i: usize) -> Option<usize> {
    let at = |p: usize| t.get(p).copied();
    let mut pos = i;
    if matches!(at(pos), Some(0x2B | 0x2D)) {
        pos += 1;
    }
    if at(pos).is_some_and(is_digit) {
        while at(pos).is_some_and(is_digit) {
            pos += 1;
        }
        if at(pos) == Some(u16::from(b'.')) {
            pos += 1;
            while at(pos).is_some_and(is_digit) {
                pos += 1;
            }
        }
    } else if at(pos) == Some(u16::from(b'.')) && at(pos + 1).is_some_and(is_digit) {
        pos += 1;
        while at(pos).is_some_and(is_digit) {
            pos += 1;
        }
    } else {
        return None;
    }
    if matches!(at(pos), Some(0x45 | 0x65)) {
        let mut p = pos + 1;
        if matches!(at(p), Some(0x2B | 0x2D)) {
            p += 1;
        }
        if at(p).is_some_and(is_digit) {
            while at(p).is_some_and(is_digit) {
                p += 1;
            }
            pos = p;
        }
    }
    Some(pos - i)
}

/// True if the whole string is a number in the form above.
fn is_number_text(units: &[u16]) -> bool {
    match_number(units, 0) == Some(units.len()) && !units.is_empty()
}

/// Converts UTF-16 units to a String (lone surrogates become U+FFFD).
fn to_string(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

struct Parser<'a> {
    t: &'a [u16],
    i: usize,
    /// Was the most recently read label quoted? (quoted numeric internal labels stay labels)
    last_quoted: bool,
}

impl Parser<'_> {
    fn at(&self, p: usize) -> Option<u16> {
        self.t.get(p).copied()
    }

    fn err<T>(&self, msg: &str, at: usize) -> Result<T, NewickError> {
        Err(NewickError::new(msg, self.t, at))
    }

    /// Skips whitespace and [comments].
    fn skip(&mut self) -> Result<(), NewickError> {
        loop {
            while self.at(self.i).is_some_and(is_ws) {
                self.i += 1;
            }
            if self.at(self.i) == Some(u16::from(b'[')) {
                let start = self.i;
                let mut depth = 0i32;
                loop {
                    match self.at(self.i) {
                        Some(0x5B) => depth += 1,
                        Some(0x5D) => depth -= 1,
                        _ => {}
                    }
                    self.i += 1;
                    if !(depth > 0 && self.i < self.t.len()) {
                        break;
                    }
                }
                if depth > 0 {
                    return self.err("Unterminated [comment]", start);
                }
            } else {
                return Ok(());
            }
        }
    }

    /// Reads a quoted or unquoted label; None if there is none at this position.
    fn label(&mut self) -> Result<Option<String>, NewickError> {
        self.skip()?;
        self.last_quoted = false;
        if self.at(self.i) == Some(u16::from(b'\'')) {
            self.last_quoted = true;
            let start = self.i;
            self.i += 1;
            let mut out: Vec<u16> = Vec::new();
            loop {
                let Some(c) = self.at(self.i) else {
                    return self.err("Unterminated quoted label", start);
                };
                if c == u16::from(b'\'') {
                    if self.at(self.i + 1) == Some(u16::from(b'\'')) {
                        out.push(u16::from(b'\''));
                        self.i += 2;
                        continue;
                    }
                    self.i += 1;
                    return Ok(Some(to_string(&out)));
                }
                out.push(c);
                self.i += 1;
            }
        }
        let start = self.i;
        while self.at(self.i).is_some_and(|u| !is_delim(u)) {
            self.i += 1;
        }
        Ok((self.i > start).then(|| to_string(&self.t[start..self.i])))
    }

    /// Reads an optional ":length".
    fn length(&mut self) -> Result<Option<f64>, NewickError> {
        self.skip()?;
        if self.at(self.i) != Some(u16::from(b':')) {
            return Ok(None);
        }
        self.i += 1;
        self.skip()?;
        let Some(len) = match_number(self.t, self.i) else {
            return self.err("Expected a branch length number after \":\"", self.i);
        };
        let text = to_string(&self.t[self.i..self.i + len]);
        self.i += len;
        let v: f64 = text.parse().unwrap_or(f64::NAN);
        if !v.is_finite() {
            return self.err("Branch length is not a finite number", self.i - len);
        }
        Ok(Some(v))
    }

    fn subtree(&mut self, depth: usize) -> Result<TreeNode, NewickError> {
        if depth > MAX_DEPTH {
            return self.err(&format!("Tree is nested more than {MAX_DEPTH} levels deep"), self.i);
        }
        self.skip()?;
        if self.at(self.i) == Some(u16::from(b'(')) {
            let open = self.i;
            self.i += 1;
            let mut children = vec![self.subtree(depth + 1)?];
            loop {
                self.skip()?;
                match self.at(self.i) {
                    Some(0x2C) => {
                        self.i += 1;
                        children.push(self.subtree(depth + 1)?);
                    }
                    Some(0x29) => {
                        self.i += 1;
                        break;
                    }
                    None => return self.err("Unbalanced parentheses: the \"(\" was never closed", open),
                    Some(c) => {
                        return self.err(
                            &format!("Expected \",\" or \")\" but found \"{}\"", to_string(&[c])),
                            self.i,
                        );
                    }
                }
            }
            let mut node = TreeNode::with_children(children);
            if let Some(lab) = self.label()? {
                let trimmed: Vec<u16> = to_trimmed_units(&lab);
                let support = if !self.last_quoted && is_number_text(&trimmed) {
                    to_string(&trimmed).parse::<f64>().ok().filter(|v| v.is_finite())
                } else {
                    None
                };
                match support {
                    Some(v) => node.support = Some(v),
                    None => node.label = Some(lab),
                }
            }
            if let Some(len) = self.length()? {
                node.length = Some(len);
            }
            return Ok(node);
        }
        let at = self.i;
        let Some(name) = self.label()? else {
            let message = match self.at(self.i) {
                None => "Unexpected end of input: expected a taxon name or \"(\"".to_string(),
                Some(c) => format!("Expected a taxon name or \"(\" but found \"{}\"", to_string(&[c])),
            };
            return self.err(&message, at);
        };
        let mut node = TreeNode::leaf(&name);
        if let Some(len) = self.length()? {
            node.length = Some(len);
        }
        Ok(node)
    }

    /// Parses one `subtree ;` and returns it.
    fn one_tree(&mut self) -> Result<TreeNode, NewickError> {
        self.skip()?;
        if self.i >= self.t.len() {
            return self.err("The input is empty: expected a Newick tree", self.i);
        }
        let root = self.subtree(0)?;
        self.skip()?;
        if self.at(self.i) != Some(u16::from(b';')) {
            return match self.at(self.i) {
                None => self.err("Missing \";\" at the end of the tree", self.i),
                Some(c) => self.err(&format!("Expected \";\" but found \"{}\"", to_string(&[c])), self.i),
            };
        }
        self.i += 1;
        Ok(root)
    }
}

/// JavaScript `trim()` of a string, as UTF-16 units.
fn to_trimmed_units(s: &str) -> Vec<u16> {
    s.trim_matches(is_js_whitespace).encode_utf16().collect()
}

/// Parses the already-converted text (the recursive work).
fn parse_units(units: &[u16]) -> Result<ParsedNewick, NewickError> {
    let mut p = Parser {
        t: units,
        i: 0,
        last_quoted: false,
    };
    let first = p.one_tree()?;
    let mut extra = 0;
    loop {
        p.skip()?;
        if p.i >= units.len() {
            break;
        }
        p.one_tree()?;
        extra += 1;
    }
    Ok(ParsedNewick {
        tree: Tree { root: first },
        extra_trees: extra,
    })
}

/// Parses the first tree in `text`. Returns a `NewickError` with a position for malformed input.
///
/// The parser recurses once per nesting level (up to 3000). Unoptimised (debug) frames are large and Tauri's worker threads
/// have 2 MB stacks, so text with many "(" is parsed on a scoped thread with a 64 MB stack: deep input can never overflow
/// the caller's stack. Ordinary trees (up to 64 opening parentheses) are parsed in place with no thread.
pub fn parse_newick(text: &str) -> Result<ParsedNewick, NewickError> {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.iter().filter(|&&u| u == u16::from(b'(')).count() <= 64 {
        return parse_units(&units);
    }
    std::thread::scope(|scope| {
        match std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn_scoped(scope, || parse_units(&units))
        {
            Ok(handle) => handle
                .join()
                .unwrap_or_else(|_| Err(NewickError::new("The Newick text could not be parsed", &units, 0))),
            Err(_) => parse_units(&units), // the thread could not be created: parse in place (fine for all but pathological input)
        }
    })
}

/// Quotes a label only when needed (always for an internal label that looks like a number, so it is not read back as support).
fn quote_label(s: &str, internal: bool) -> String {
    let numeric = internal && is_number_text(&to_trimmed_units(s));
    if !s.is_empty() && !numeric && !s.chars().any(|c| is_js_whitespace(c) || "()[]',:;".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "''"))
}

/// What to include when writing.
#[derive(Debug, Clone, Copy)]
pub struct WriteOptions {
    /// Write internal support values as labels (default true).
    pub include_support: bool,
    /// Write branch lengths (default true).
    pub include_lengths: bool,
}

impl Default for WriteOptions {
    /// Support values and lengths both included.
    fn default() -> Self {
        Self {
            include_support: true,
            include_lengths: true,
        }
    }
}

/// Writes a tree as Newick. Numbers use JavaScript's shortest exact representation, so a re-read tree is identical.
pub fn write_newick(tree: &Tree, opts: WriteOptions) -> String {
    fn walk(n: &TreeNode, opts: WriteOptions) -> String {
        let mut s = if n.is_leaf() {
            quote_label(n.name.as_deref().unwrap_or(""), false)
        } else {
            format!(
                "({})",
                n.children.iter().map(|c| walk(c, opts)).collect::<Vec<_>>().join(",")
            )
        };
        if !n.is_leaf() {
            if let Some(label) = &n.label {
                s.push_str(&quote_label(label, true));
            } else if let (true, Some(support)) = (opts.include_support, n.support) {
                s.push_str(&js_number_to_string(support));
            }
        }
        if let (true, Some(length)) = (opts.include_lengths, n.length) {
            s.push(':');
            s.push_str(&js_number_to_string(length));
        }
        s
    }
    format!("{};", walk(&tree.root, opts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::leaf_names;

    fn parse(s: &str) -> Tree {
        parse_newick(s).expect("valid newick").tree // test code
    }
    fn names(t: &Tree) -> Vec<String> {
        leaf_names(t)
    }

    // Ported from tests/unit/newick.test.ts ("specific parsing rules").
    #[test]
    fn quoted_labels_with_spaces_parentheses_and_doubled_quotes() {
        let t = parse("('Homo sapiens (human)':1,'it''s':2,(C,D));");
        assert_eq!(names(&t), vec!["Homo sapiens (human)", "it's", "C", "D"]);
        assert_eq!(
            write_newick(&t, WriteOptions::default()),
            "('Homo sapiens (human)':1,'it''s':2,(C,D));"
        );
    }

    #[test]
    fn scientific_notation_and_negative_lengths_are_exact() {
        let t = parse("(A:1e-3,B:2.5E+2,(C:-1.5e-2,D:.5):3.);");
        assert_eq!(t.root.children[0].length, Some(0.001));
        assert_eq!(t.root.children[1].length, Some(250.0));
        assert_eq!(t.root.children[2].children[0].length, Some(-0.015));
        assert_eq!(t.root.children[2].children[1].length, Some(0.5));
        assert_eq!(t.root.children[2].length, Some(3.0));
    }

    #[test]
    fn numeric_internal_labels_become_support_others_stay_labels_missing_lengths_stay_none() {
        let t = parse("((A:1,B:1)95:0.5,(C:1,D:1)clade_x:0.5,E)root;");
        assert_eq!(
            (t.root.children[0].support, t.root.children[0].label.clone()),
            (Some(95.0), None)
        );
        assert_eq!(t.root.children[1].label.as_deref(), Some("clade_x"));
        assert_eq!(t.root.label.as_deref(), Some("root"));
        assert_eq!(t.root.children[2].length, None);
    }

    #[test]
    fn a_quoted_numeric_internal_label_stays_a_label_and_survives_a_round_trip() {
        let t = parse("((A,B)'95',C,D);");
        assert_eq!(
            (t.root.children[0].label.as_deref(), t.root.children[0].support),
            (Some("95"), None)
        );
        assert_eq!(parse(&write_newick(&t, WriteOptions::default())), t);
    }

    #[test]
    fn underscores_are_kept_and_support_and_lengths_can_be_left_out() {
        assert_eq!(names(&parse("(HBA_HUMAN,B,C);")), vec!["HBA_HUMAN", "B", "C"]);
        let t = parse("((A:1,B:1)95:0.5,C:1,D:1);");
        assert_eq!(write_newick(&t, WriteOptions::default()), "((A:1,B:1)95:0.5,C:1,D:1);");
        assert_eq!(
            write_newick(
                &t,
                WriteOptions {
                    include_support: false,
                    include_lengths: true
                }
            ),
            "((A:1,B:1):0.5,C:1,D:1);"
        );
        assert_eq!(
            write_newick(
                &t,
                WriteOptions {
                    include_support: true,
                    include_lengths: false
                }
            ),
            "((A,B)95,C,D);"
        );
    }

    #[test]
    fn a_very_deep_tree_is_refused_with_a_clear_message() {
        let deep = format!("{}A{};", "(".repeat(4000), ",B)".repeat(4000));
        assert!(
            parse_newick(&deep)
                .expect_err("too deep")
                .message
                .contains("nested more than")
        );
    }

    #[test]
    fn deep_but_allowed_nesting_parses_even_in_an_unoptimised_build() {
        let deep = format!("{}A:1{};", "(".repeat(2900), ",B:1)".repeat(2900));
        let t = parse(&deep);
        assert_eq!(names(&t).len(), 2901);
        let too_deep =
            parse_newick(&format!("{}A{};", "(".repeat(3001), ",B)".repeat(3001))).expect_err("one level too deep");
        assert!(too_deep.message.contains("nested more than"));
    }

    #[test]
    fn errors_carry_positions_lines_and_columns() {
        let e = parse_newick("").expect_err("empty");
        assert_eq!((e.line, e.column), (1, 1));
        assert!(e.message.contains("empty"));
        let e = parse_newick("(A,B,C)").expect_err("missing semicolon");
        assert!(e.message.contains("Missing \";\""));
        let e = parse_newick("(A,\n  B,\n  C))").expect_err("extra paren");
        assert_eq!(e.line, 3);
        assert_eq!(BioError::from(e).code, BioErrorCode::NewickSyntax);
        assert!(
            parse_newick("((A,B,C)")
                .expect_err("unbalanced")
                .message
                .contains("never closed")
        );
        assert!(
            parse_newick("((A,B,C);")
                .expect_err("unexpected ;")
                .message
                .contains("Expected \",\" or \")\" but found \";\"")
        );
        assert!(
            parse_newick("(A:x,B);")
                .expect_err("bad length")
                .message
                .contains("branch length")
        );
        assert!(
            parse_newick("(A:1e999,B);")
                .expect_err("infinite length")
                .message
                .contains("not a finite number")
        );
        assert!(
            parse_newick("(A[never closed,B);")
                .expect_err("comment")
                .message
                .contains("Unterminated [comment]")
        );
        assert!(
            parse_newick("('abc,B);")
                .expect_err("quote")
                .message
                .contains("Unterminated quoted label")
        );
    }

    #[test]
    fn comments_whitespace_and_multiple_trees() {
        let r = parse_newick("  ( A [comment] : 1 ,\n B : 2 , ( C , D ) ) ;  ").expect("valid"); // test code
        assert_eq!(names(&r.tree), vec!["A", "B", "C", "D"]);
        assert_eq!(parse_newick("(A,B,C);(A,C,B);").expect("valid").extra_trees, 1); // test code
    }

    #[test]
    fn write_then_read_is_the_identity_for_unusual_numbers() {
        let mut t = parse("(A,B,C);");
        for (k, len) in [0.1 + 0.2, 1e-7, 1.5e300, -0.0001, 123_456_789.123_456_79]
            .iter()
            .enumerate()
        {
            t.root.children.push(TreeNode {
                name: Some(format!("x{k}")),
                length: Some(*len),
                ..TreeNode::default()
            });
        }
        assert_eq!(parse(&write_newick(&t, WriteOptions::default())), t);
    }

    #[test]
    fn number_text_recogniser_matches_the_javascript_regular_expression() {
        let ok = ["1", "+1", "-1.5", ".5", "3.", "1e5", "1E-5", "2.5e+3", "0"];
        let bad = ["", "e5", "1e", "1.5.5", "abc", "--1", ".", "+", "1e+"];
        for s in ok {
            assert!(is_number_text(&s.encode_utf16().collect::<Vec<_>>()), "{s}");
        }
        for s in bad {
            assert!(!is_number_text(&s.encode_utf16().collect::<Vec<_>>()), "{s}");
        }
    }
}
