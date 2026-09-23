# Audify

A small, fast audio file editor for windows.

**Download:** get the Windows installer from the [Releases page](https://github.com/alex-cortina/audify/releases/latest).

## Run

```
npm install
npm start
```

Open a file with `Ctrl+O`, or drop it on the window, or `npm start -- song.wav`.
Reads WAV, MP3, OGG, FLAC, M4A, AIFF. Also takes video files (MP4, MOV, MKV, WEBM) and rips out the audio track. Saves 16-bit WAV or MP3 (128/192/320 kbps).

## Keys

| Key | Does |
|---|---|
| Space | Play / pause. Plays the selection if there is one. |
| Esc | Stop |
| Click / drag | Set cursor / select |
| Shift+click | Extend selection |
| Double-click, Ctrl+A | Select all |
| Ctrl+X / C / V | Cut / copy / paste |
| Delete | Delete selection |
| Ctrl+T | Trim to selection |
| Ctrl+L | Silence selection |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S | Export WAV |
| Ctrl+Shift+S | Export MP3 |
| + / - / 0 / Z | Zoom in / out / fit / to selection |
| Ctrl+wheel | Zoom at mouse |
| Wheel | Scroll |
| Home / End / Arrows | Move cursor |

Fade In, Fade Out, Normalize, Reverse and Gain use the selection. With no selection they use the whole file.

## Build the EXE

```
npm run dist
```

The installer and a portable folder land in `dist/`.

## License

MIT. See `LICENSE`. The bundled MP3 encoder (lamejs) is LGPL-3.0. See `THIRD_PARTY_NOTICES.md`.
