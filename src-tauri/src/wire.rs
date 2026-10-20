//! Binary reply to the page: a JSON state block followed by sample splices.
//!
//! Layout (all little-endian, every section 4-byte aligned):
//!   u32 json_len, json bytes, zero padding to 4
//!   u32 splice_count
//!   per splice: u32 at, u32 remove, u32 new_len, u32 channels, then channels * new_len f32 (planar)

use crate::editor::PageSplice;

pub fn pack(state: &serde_json::Value, splices: &[PageSplice<'_>]) -> Vec<u8> {
    let json = state.to_string().into_bytes();
    let samples: usize = splices.iter().map(|s| s.data.len() * s.data.first().map_or(0, Vec::len)).sum();
    let mut out = Vec::with_capacity(8 + json.len() + 3 + splices.len() * 16 + samples * 4);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    out.extend_from_slice(&(splices.len() as u32).to_le_bytes());
    for s in splices {
        let new_len = s.data.first().map_or(0, Vec::len);
        for v in [s.at, s.remove, new_len, s.data.len()] {
            out.extend_from_slice(&(v as u32).to_le_bytes());
        }
        for ch in s.data {
            out.extend_from_slice(f32_bytes(ch));
        }
    }
    out
}

/// The raw bytes of a float slice. On a little-endian CPU (every Windows PC) these are
/// already in the order the page reads, so one copy does the whole channel.
#[cfg(target_endian = "little")]
fn f32_bytes(v: &[f32]) -> &[u8] {
    // SAFETY: f32 has no padding and any byte pattern is a valid u8; the length is exact.
    unsafe { std::slice::from_raw_parts(v.as_ptr().cast::<u8>(), std::mem::size_of_val(v)) }
}
