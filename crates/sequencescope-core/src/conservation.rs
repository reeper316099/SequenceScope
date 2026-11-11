//! Per-column conservation of a multiple alignment: residue counts, identity, Shannon entropy, and a consensus sequence.
//! Port of `src/bio/conservation.ts` (formulas in the header of that file). The entropy uses `Math.log2`, reproduced by
//! `js_log2`, and sums the terms in the order a JavaScript object lists its keys, so the numbers are identical.
//!
//! Rows are assumed to be made of single UTF-16 units (letters and '-'), which is all an alignment contains.

use crate::alphabet::js_len;
use crate::error::{BioError, BioErrorCode};
use crate::jsnum::{js_cmp, js_log2, js_to_fixed};
use crate::types::Alphabet;

/// Statistics for one alignment column.
#[derive(Debug, Clone, PartialEq)]
pub struct ColumnStat {
    pub gaps: usize,
    pub residues: usize,
    /// Residue counts in the order a JavaScript object would list them (digits first, then first appearance).
    pub counts: Vec<(char, usize)>,
    /// Most common residue (alphabetically first among ties), if any.
    pub top: Option<char>,
    pub identity: f64,
    pub entropy: f64,
    pub conservation: f64,
    pub consensus: char,
}

/// Orders counts like `Object.values` does: keys that are array indices ("0".."9" here) first, ascending, then the rest in
/// insertion order.
fn js_object_order(insertion: Vec<(char, usize)>) -> Vec<(char, usize)> {
    let (mut digits, rest): (Vec<_>, Vec<_>) = insertion.into_iter().partition(|(ch, _)| ch.is_ascii_digit());
    digits.sort_by_key(|(ch, _)| *ch);
    digits.extend(rest);
    digits
}

/// Statistics for one alignment column (a string with one character per sequence).
pub fn column_stat(column: &str, alphabet: Alphabet, threshold: f64) -> Result<ColumnStat, BioError> {
    let n = js_len(column);
    if n == 0 {
        return Err(BioError::new(
            BioErrorCode::InvalidArgument,
            "A column needs at least one sequence.",
        ));
    }
    let mut insertion: Vec<(char, usize)> = Vec::new();
    let mut gaps = 0usize;
    for ch in column.chars() {
        if ch == '-' {
            gaps += 1;
        } else if let Some(entry) = insertion.iter_mut().find(|(c, _)| *c == ch) {
            entry.1 += 1;
        } else {
            insertion.push((ch, 1));
        }
    }
    let residues = n - gaps;
    // The most common residue; ties go to the alphabetically first (keys sorted like JavaScript's default sort).
    let mut sorted: Vec<(char, usize)> = insertion.clone();
    sorted.sort_by(|a, b| js_cmp(&a.0.to_string(), &b.0.to_string()));
    let (mut top, mut best) = (None, 0usize);
    for (ch, count) in &sorted {
        if *count > best {
            best = *count;
            top = Some(*ch);
        }
    }
    let counts = js_object_order(insertion);
    let mut entropy = 0.0f64;
    for (_, c) in &counts {
        let p = *c as f64 / residues as f64;
        entropy -= p * js_log2(p);
    }
    entropy = entropy.abs(); // avoid -0
    let hmax = js_log2(if alphabet == Alphabet::Protein { 20.0 } else { 4.0 });
    let identity = best as f64 / n as f64;
    let conservation = if residues == 0 {
        0.0
    } else {
        (1.0 - entropy / hmax).max(0.0) * (1.0 - gaps as f64 / n as f64)
    };
    let consensus = if gaps as f64 / n as f64 > 0.5 || residues == 0 {
        '-'
    } else if identity >= threshold {
        top.unwrap_or('-')
    } else {
        '.'
    };
    Ok(ColumnStat {
        gaps,
        residues,
        counts,
        top,
        identity,
        entropy,
        conservation,
        consensus,
    })
}

/// Statistics for the whole alignment.
#[derive(Debug, Clone, PartialEq)]
pub struct Conservation {
    pub columns: Vec<ColumnStat>,
    pub consensus: String,
    pub mean_identity: f64,
    /// Columns where every sequence has the same residue and no gaps.
    pub fully_conserved: usize,
}

/// Statistics for every column of an alignment (rows of equal length).
pub fn conservation(rows: &[String], alphabet: Alphabet, threshold: f64) -> Result<Conservation, BioError> {
    let len = rows.first().map_or(0, |r| js_len(r));
    for (k, r) in rows.iter().enumerate() {
        if js_len(r) != len {
            return Err(BioError::new(
                BioErrorCode::NotAligned,
                format!("Row {} has {} columns but the first has {len}.", k + 1, js_len(r)),
            ));
        }
    }
    let chars: Vec<Vec<char>> = rows.iter().map(|r| r.chars().collect()).collect();
    let mut columns = Vec::with_capacity(len);
    for c in 0..len {
        let column: String = chars.iter().filter_map(|r| r.get(c)).collect();
        columns.push(column_stat(&column, alphabet, threshold)?);
    }
    let mut sum = 0.0f64;
    for c in &columns {
        sum += c.identity; // summed left to right, like Array.reduce
    }
    Ok(Conservation {
        consensus: columns.iter().map(|c| c.consensus).collect(),
        mean_identity: if len == 0 { 0.0 } else { sum / len as f64 },
        fully_conserved: columns.iter().filter(|c| c.gaps == 0 && c.identity == 1.0).count(),
        columns,
    })
}

/// Conservation as CSV: one row per column with position, consensus, identity, entropy, conservation, and gap count.
pub fn conservation_csv(rows: &[String], alphabet: Alphabet) -> Result<String, BioError> {
    let cons = conservation(rows, alphabet, 0.5)?;
    let mut lines = vec!["column,consensus,identity,entropy_bits,conservation,gaps".to_string()];
    for (k, c) in cons.columns.iter().enumerate() {
        lines.push(format!(
            "{},{},{},{},{},{}",
            k + 1,
            c.consensus,
            js_to_fixed(c.identity, 4),
            js_to_fixed(c.entropy, 4),
            js_to_fixed(c.conservation, 4),
            c.gaps
        ));
    }
    Ok(lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from tests/unit (conservation): hand-computed columns.
    #[test]
    fn a_fully_conserved_column_has_zero_entropy_and_full_conservation() {
        let c = column_stat("AAAA", Alphabet::Dna, 0.5).expect("column");
        assert_eq!((c.gaps, c.residues, c.top, c.consensus), (0, 4, Some('A'), 'A'));
        assert_eq!((c.identity, c.entropy, c.conservation), (1.0, 0.0, 1.0));
    }

    #[test]
    fn an_even_split_has_one_bit_of_entropy() {
        let c = column_stat("AACC", Alphabet::Dna, 0.5).expect("column");
        assert_eq!(c.entropy, 1.0);
        assert_eq!(c.conservation, 0.5); // 1 - 1/2
        assert_eq!(c.top, Some('A'), "ties go to the alphabetically first residue");
        assert_eq!(c.consensus, 'A', "identity 0.5 meets the default threshold");
        assert_eq!(column_stat("ACGT", Alphabet::Dna, 0.5).expect("column").consensus, '.');
    }

    #[test]
    fn gaps_lower_identity_and_conservation_and_can_make_the_consensus_a_gap() {
        let c = column_stat("AA--", Alphabet::Dna, 0.5).expect("column");
        assert_eq!((c.gaps, c.residues, c.identity, c.conservation), (2, 2, 0.5, 0.5));
        assert_eq!(c.consensus, 'A', "exactly half gaps is not more than half");
        assert_eq!(column_stat("A---", Alphabet::Dna, 0.5).expect("column").consensus, '-');
        let all_gaps = column_stat("----", Alphabet::Dna, 0.5).expect("column");
        assert_eq!((all_gaps.residues, all_gaps.conservation, all_gaps.top), (0, 0.0, None));
    }

    #[test]
    fn empty_column_and_unequal_rows_are_typed_errors() {
        assert_eq!(
            column_stat("", Alphabet::Dna, 0.5).expect_err("empty").code,
            BioErrorCode::InvalidArgument
        );
        let e = conservation(&["AC".to_string(), "A".to_string()], Alphabet::Dna, 0.5).expect_err("ragged");
        assert_eq!(
            (e.code, e.message.as_str()),
            (BioErrorCode::NotAligned, "Row 2 has 1 columns but the first has 2.")
        );
    }

    #[test]
    fn whole_alignment_summary_and_csv() {
        let rows: Vec<String> = ["ACGT", "ACGA", "A-GT"].iter().map(|s| s.to_string()).collect();
        let cons = conservation(&rows, Alphabet::Dna, 0.5).expect("alignment");
        assert_eq!(cons.consensus, "ACGT");
        assert_eq!(cons.fully_conserved, 2, "columns 1 and 3");
        let csv = conservation_csv(&rows, Alphabet::Dna).expect("csv");
        assert!(
            csv.starts_with("column,consensus,identity,entropy_bits,conservation,gaps\n1,A,1.0000,0.0000,1.0000,0\n")
        );
        assert!(csv.ends_with('\n'));
        assert_eq!(conservation(&[], Alphabet::Dna, 0.5).expect("empty").mean_identity, 0.0);
    }

    #[test]
    fn digits_are_listed_first_like_a_javascript_object() {
        let ordered = js_object_order(vec![('B', 1), ('7', 2), ('A', 3), ('2', 4)]);
        assert_eq!(ordered, vec![('2', 4), ('7', 2), ('B', 1), ('A', 3)]);
    }
}
