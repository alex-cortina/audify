//! Read an audio or video file into one Vec<f32> per channel, at the file's own sample rate.

use std::fs::File;
use std::path::Path;
use std::sync::LazyLock;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::registry::CodecRegistry;
use symphonia::core::errors::Error;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::editor::Chans;

/// Symphonia's own decoders, plus libopus for Opus (common in WEBM, MKV and YouTube M4A files).
static CODECS: LazyLock<CodecRegistry> = LazyLock::new(|| {
    let mut r = CodecRegistry::new();
    symphonia::default::register_enabled_codecs(&mut r);
    r.register_audio_decoder::<symphonia_adapter_libopus::OpusDecoder>();
    r
});

pub fn decode_file(path: &Path) -> Result<(Chans, u32), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| format!("unsupported format: {e}"))?;
    let track = format.default_track(TrackType::Audio).ok_or("no audio track")?;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or("no audio track")?;
    let mut decoder = CODECS
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .map_err(|e| format!("unsupported codec: {e}"))?;
    let track_id = track.id;
    let mut rate = params.sample_rate.unwrap_or(0);

    let mut chans: Chans = Vec::new();
    let mut tmp: Vec<Vec<f32>> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            // A broken tail should not lose the whole file.
            Err(Error::IoError(_)) if !chans.is_empty() => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                if rate == 0 {
                    rate = buf.spec().rate();
                }
                buf.copy_to_vecs_planar(&mut tmp);
                if chans.is_empty() {
                    chans = vec![Vec::new(); tmp.len()];
                }
                for (dst, src) in chans.iter_mut().zip(&tmp) {
                    dst.extend_from_slice(src);
                }
            }
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    if chans.is_empty() || chans[0].is_empty() || rate == 0 {
        return Err("no audio decoded".into());
    }
    Ok((chans, rate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode;

    #[test]
    fn round_trip_wav_and_mp3() {
        let tone: Vec<f32> = (0..48000).map(|i| (i as f32 / 15.0).sin() * 0.5).collect();
        let chans = vec![tone.clone(), tone];
        let dir = std::env::temp_dir();

        let wav_path = dir.join("audify-test.wav");
        std::fs::write(&wav_path, encode::wav(&chans, 48000)).unwrap();
        let (got, rate) = decode_file(&wav_path).unwrap();
        assert_eq!((got.len(), got[0].len(), rate), (2, 48000, 48000));
        assert!((got[0][100] - chans[0][100]).abs() < 1e-3);

        let mp3_path = dir.join("audify-test.mp3");
        std::fs::write(&mp3_path, encode::mp3(&chans, 48000, 192, |_| {}).unwrap()).unwrap();
        let (got, rate) = decode_file(&mp3_path).unwrap();
        assert_eq!((got.len(), rate), (2, 48000));
        // MP3 adds a little padding; the length should be close.
        assert!((got[0].len() as i64 - 48000).abs() < 4000, "len {}", got[0].len());

        let _ = std::fs::remove_file(wav_path);
        let _ = std::fs::remove_file(mp3_path);
    }
}

/// Times decoding a real file: set AUDIFY_DECODE_FILE and run
/// `cargo test --release decode_real_file -- --nocapture`. Skipped otherwise.
#[test]
fn decode_real_file() {
    let Ok(path) = std::env::var("AUDIFY_DECODE_FILE") else { return };
    let t = std::time::Instant::now();
    let (chans, rate) = decode_file(Path::new(&path)).unwrap();
    println!("{path}: {} ch, {rate} Hz, {:.2} s of audio, decoded in {} ms", chans.len(), chans[0].len() as f64 / rate as f64, t.elapsed().as_millis());
}

