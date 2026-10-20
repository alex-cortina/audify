//! Write the document as 16-bit WAV or as MP3 (LAME).

use std::num::NonZeroU32;

use mp3lame_encoder::{Bitrate, Builder, DualPcm, FlushNoGap, MonoPcm, Quality};

use crate::editor::Chans;

fn to_i16(v: f32) -> i16 {
    let v = v.clamp(-1.0, 1.0);
    if v < 0.0 { (v * 32768.0) as i16 } else { (v * 32767.0) as i16 }
}

pub fn wav(chans: &Chans, rate: u32) -> Vec<u8> {
    let n_ch = chans.len() as u32;
    let n = chans[0].len() as u32;
    let data_size = n * n_ch * 2;
    let mut out = Vec::with_capacity(44 + data_size as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_size).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&(n_ch as u16).to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * n_ch * 2).to_le_bytes());
    out.extend_from_slice(&((n_ch * 2) as u16).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_size.to_le_bytes());
    for i in 0..n as usize {
        for ch in chans {
            out.extend_from_slice(&to_i16(ch[i]).to_le_bytes());
        }
    }
    out
}

/// Rates MP3 can store. Anything else is resampled to 44100 by LAME.
const MP3_RATES: [u32; 9] = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/// Encode the first two channels. `progress` gets 0..=99 as encoding moves along.
pub fn mp3(chans: &Chans, rate: u32, kbps: u32, mut progress: impl FnMut(u32)) -> Result<Vec<u8>, String> {
    let err = |e: &dyn std::fmt::Debug| format!("MP3 encoder: {e:?}");
    let stereo = chans.len() >= 2;
    let brate = match kbps {
        128 => Bitrate::Kbps128,
        320 => Bitrate::Kbps320,
        _ => Bitrate::Kbps192,
    };
    let mut b = Builder::new().ok_or("MP3 encoder: could not start LAME")?;
    b.set_num_channels(if stereo { 2 } else { 1 }).map_err(|e| err(&e))?;
    b.set_sample_rate(rate).map_err(|e| err(&e))?;
    if !MP3_RATES.contains(&rate) {
        b.set_output_sample_rate(NonZeroU32::new(44100)).map_err(|e| err(&e))?;
    }
    b.set_brate(brate).map_err(|e| err(&e))?;
    b.set_quality(Quality::NearBest).map_err(|e| err(&e))?;
    let mut enc = b.build().map_err(|e| err(&e))?;

    let n = chans[0].len();
    const BLOCK: usize = 1152 * 32;
    let mut out = Vec::with_capacity(n / 8);
    let mut last = u32::MAX;
    for start in (0..n).step_by(BLOCK) {
        let end = (start + BLOCK).min(n);
        out.reserve(mp3lame_encoder::max_required_buffer_size(end - start));
        if stereo {
            enc.encode_to_vec(DualPcm { left: &chans[0][start..end], right: &chans[1][start..end] }, &mut out)
        } else {
            enc.encode_to_vec(MonoPcm(&chans[0][start..end]), &mut out)
        }
        .map_err(|e| err(&e))?;
        let pct = (start as u64 * 100 / n as u64) as u32;
        if pct != last {
            last = pct;
            progress(pct);
        }
    }
    out.reserve(7200);
    enc.flush_to_vec::<FlushNoGap>(&mut out).map_err(|e| err(&e))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_and_size() {
        let w = wav(&vec![vec![0.0, 1.0, -1.0]; 2], 44100);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(w.len(), 44 + 3 * 2 * 2);
        assert_eq!(i16::from_le_bytes([w[48], w[49]]), 32767);
        assert_eq!(i16::from_le_bytes([w[52], w[53]]), -32768);
    }

    #[test]
    fn mp3_has_frames() {
        let tone: Vec<f32> = (0..44100).map(|i| (i as f32 / 20.0).sin() * 0.5).collect();
        for (chans, rate) in [(vec![tone.clone(), tone.clone()], 44100), (vec![tone.clone()], 37000)] {
            let m = mp3(&chans, rate, 192, |_| {}).unwrap();
            assert!(m.len() > 1000, "{} bytes", m.len());
            let sync = m.windows(2).position(|w| w[0] == 0xff && w[1] & 0xe0 == 0xe0);
            assert!(sync.is_some());
        }
    }
}
