# Third-party notices

Audify's own code is MIT licensed (see `LICENSE`).

## LAME (MP3 encoder)

- Used through the Rust crates `mp3lame-encoder` and `mp3lame-sys`, which build LAME from source
- Source: https://lame.sourceforge.io, https://github.com/DoumanAsh/mp3lame-encoder
- License: LGPL-3.0 (the crates are LGPL-3.0, LAME itself is LGPL-2.0-or-later)

LAME is linked into `audify.exe`. The full source of Audify is in this repository, so you can
rebuild it against your own modified version of LAME (change the `mp3lame-sys` dependency in
`src-tauri/Cargo.toml` and run `npm run dist`).

## Symphonia (audio decoding)

- Rust crate `symphonia` and its codec and format crates
- Source: https://github.com/pdeljanov/Symphonia
- License: MPL-2.0. Audify uses it unmodified; its source is available at the link above.

## libopus (Opus decoding)

- Used through the Rust crates `symphonia-adapter-libopus` (MIT or Apache-2.0) and `opusic-sys`,
  which build libopus from source
- Source: https://opus-codec.org, https://github.com/aschey/symphonia-adapters
- License: BSD-3-Clause (https://opus-codec.org/license/)

## Tauri and other Rust crates

The app shell is Tauri (MIT or Apache-2.0). Other Rust dependencies are listed in
`src-tauri/Cargo.lock`, and each carries its own license, mostly MIT or Apache-2.0.
The window shows its page with Microsoft Edge WebView2, which is part of Windows.
