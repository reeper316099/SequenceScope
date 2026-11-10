//! The binary frame that carries an alignment result to the page as ONE raw byte buffer (no JSON for the big DP tables).
//!
//! Layout (all integers little-endian; every table starts on an 8-byte boundary so the page can wrap it in a typed array
//! without copying):
//! ```text
//!   0   "SSB1"             magic
//!   4   u32  json_len      length of the JSON header
//!   8   u32  table_count
//!  12   u32  0             reserved
//!  16   table_count x 16-byte entries: [u8 kind][u8 name][6 zero bytes][u64 element_count]
//!                          kind: 0 = i32, 1 = u8, 2 = u16, 3 = f64, 4 = u32;  name: one ASCII letter (H, P, M, X, Y, V, S, C)
//!  16+16*count   json header bytes (json_len), then zero padding up to a multiple of 8
//!  then every table in order, each padded up to a multiple of 8
//! ```
//! The matching decoder is `src/backend/frame.ts`; both sides are tested against this description.

/// One table of numbers to ship (owned, so it can be freed as soon as it has been copied into the frame).
#[derive(Debug, Clone, PartialEq)]
pub enum Table {
    I32(u8, Vec<i32>),
    U8(u8, Vec<u8>),
    U16(u8, Vec<u16>),
    F64(u8, Vec<f64>),
    U32(u8, Vec<u32>),
}

impl Table {
    /// (kind byte, name byte, element count, bytes per element).
    fn shape(&self) -> (u8, u8, usize, usize) {
        match self {
            Self::I32(name, v) => (0, *name, v.len(), 4),
            Self::U8(name, v) => (1, *name, v.len(), 1),
            Self::U16(name, v) => (2, *name, v.len(), 2),
            Self::F64(name, v) => (3, *name, v.len(), 8),
            Self::U32(name, v) => (4, *name, v.len(), 4),
        }
    }

    /// Appends the table's bytes (little-endian) to `out`; the table is consumed so its memory is released right after.
    fn write_into(self, out: &mut Vec<u8>) {
        match self {
            Self::I32(_, v) => v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Self::U8(_, v) => out.extend_from_slice(&v),
            Self::U16(_, v) => v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Self::F64(_, v) => v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Self::U32(_, v) => v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
        }
    }
}

/// Rounds up to the next multiple of 8.
fn align8(n: usize) -> usize {
    n.div_ceil(8) * 8
}

/// Builds the frame for a JSON header and its tables. The buffer is allocated once at its exact final size.
pub fn encode_frame(json: &[u8], tables: Vec<Table>) -> Vec<u8> {
    let table_count = tables.len();
    let header_end = align8(16 + 16 * table_count + json.len());
    let body: usize = tables
        .iter()
        .map(|t| {
            let (_, _, n, size) = t.shape();
            align8(n * size)
        })
        .sum();
    let mut out: Vec<u8> = Vec::with_capacity(header_end + body);
    out.extend_from_slice(b"SSB1");
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&(table_count as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    for t in &tables {
        let (kind, name, n, _) = t.shape();
        out.extend_from_slice(&[kind, name, 0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(&(n as u64).to_le_bytes());
    }
    out.extend_from_slice(json);
    out.resize(header_end, 0);
    for t in tables {
        t.write_into(&mut out);
        out.resize(align8(out.len()), 0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A decoded table: (kind byte, name byte, raw element bytes).
    type RawTable = (u8, u8, Vec<u8>);

    /// Test-only decoder following the layout in the module docs: returns (json bytes, tables as (kind, name, element bytes)).
    fn decode(buf: &[u8]) -> (Vec<u8>, Vec<RawTable>) {
        assert_eq!(&buf[0..4], b"SSB1");
        let u32_at = |o: usize| u32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]) as usize;
        let (json_len, count) = (u32_at(4), u32_at(8));
        let mut pos = align8(16 + 16 * count + json_len);
        let json = buf[16 + 16 * count..16 + 16 * count + json_len].to_vec();
        let mut tables = Vec::new();
        for t in 0..count {
            let e = 16 + 16 * t;
            let n = u64::from_le_bytes(buf[e + 8..e + 16].try_into().expect("8 bytes")) as usize; // test code
            let size = match buf[e] {
                0 | 4 => 4,
                1 => 1,
                2 => 2,
                _ => 8,
            };
            assert_eq!(pos % 8, 0, "every table starts on an 8-byte boundary");
            tables.push((buf[e], buf[e + 1], buf[pos..pos + n * size].to_vec()));
            pos = align8(pos + n * size);
        }
        assert_eq!(pos, buf.len(), "no trailing bytes");
        (json, tables)
    }

    #[test]
    fn round_trips_json_and_every_table_kind() {
        let frame = encode_frame(
            br#"{"a":1}"#,
            vec![
                Table::I32(b'H', vec![1, -2, 300_000]),
                Table::U8(b'P', vec![1, 2, 3]),
                Table::U16(b'P', vec![513, 7]),
            ],
        );
        let (json, tables) = decode(&frame);
        assert_eq!(json, br#"{"a":1}"#);
        assert_eq!(
            tables[0],
            (
                0,
                b'H',
                [1i32, -2, 300_000].iter().flat_map(|x| x.to_le_bytes()).collect()
            )
        );
        assert_eq!(tables[1], (1, b'P', vec![1, 2, 3]));
        assert_eq!(
            tables[2],
            (2, b'P', [513u16, 7].iter().flat_map(|x| x.to_le_bytes()).collect())
        );
    }

    #[test]
    fn round_trips_f64_and_u32_tables_exactly() {
        let doubles = [0.1 + 0.2, -0.0, f64::MIN_POSITIVE, 1e300];
        let frame = encode_frame(
            b"{}",
            vec![
                Table::F64(b'V', doubles.to_vec()),
                Table::U32(b'C', vec![0, 1, u32::MAX]),
            ],
        );
        let (_, tables) = decode(&frame);
        let back: Vec<f64> = tables[0]
            .2
            .chunks(8)
            .map(|c| f64::from_le_bytes(c.try_into().expect("8 bytes")))
            .collect(); // test code
        assert_eq!(
            back.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
            doubles.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
            "bit-exact"
        );
        assert_eq!((tables[0].0, tables[1].0), (3, 4));
        assert_eq!(
            tables[1].2,
            [0u32, 1, u32::MAX]
                .iter()
                .flat_map(|x| x.to_le_bytes())
                .collect::<Vec<u8>>()
        );
    }

    #[test]
    fn empty_tables_and_no_tables_are_fine() {
        let (json, tables) = decode(&encode_frame(b"{}", vec![]));
        assert_eq!((json.as_slice(), tables.len()), (b"{}".as_slice(), 0));
        let (_, tables) = decode(&encode_frame(
            b"{}",
            vec![Table::I32(b'H', vec![]), Table::U8(b'P', vec![])],
        ));
        assert_eq!(tables.len(), 2);
        assert!(tables.iter().all(|t| t.2.is_empty()));
    }

    #[test]
    fn the_buffer_is_allocated_once_at_its_exact_size() {
        let frame = encode_frame(
            b"{\"x\":[1,2,3]}",
            vec![Table::I32(b'H', vec![0; 1001]), Table::U8(b'P', vec![0; 1001])],
        );
        assert_eq!(
            frame.len(),
            frame.capacity(),
            "capacity was computed exactly, so no reallocation or slack"
        );
        assert_eq!(frame.len() % 8, 0);
    }

    #[test]
    fn align8_rounds_up() {
        assert_eq!(
            [align8(0), align8(1), align8(8), align8(9), align8(16)],
            [0, 8, 8, 16, 16]
        );
    }
}
