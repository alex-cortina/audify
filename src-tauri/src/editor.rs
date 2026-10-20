//! The open document: samples, edits, undo/redo and the clipboard.
//!
//! Every edit is a list of splices ("replace samples [at, at + old_len) with `new`").
//! Undo plays the splices backwards with old/new swapped, so the history stores only
//! the samples an edit touched, not a full copy of the file.
//!
//! The page keeps a mirror of the samples for drawing and playback. Each edit returns
//! the splices so the page can apply the same change to its copy.

pub type Chans = Vec<Vec<f32>>;
pub type Sel = Option<(usize, usize)>;

const MAX_UNDO: usize = 30;

pub struct Splice {
    pub at: usize,
    pub old: Chans,
    pub new: Chans,
}

impl Splice {
    pub fn old_len(&self) -> usize {
        self.old.first().map_or(0, Vec::len)
    }
    pub fn new_len(&self) -> usize {
        self.new.first().map_or(0, Vec::len)
    }
}

/// One change for the page: replace `remove` samples at `at` with `data`.
pub struct PageSplice<'a> {
    pub at: usize,
    pub remove: usize,
    pub data: &'a Chans,
}

struct Step {
    splices: Vec<Splice>,
    before: (Sel, usize),
    after: (Sel, usize),
}

struct Clip {
    chans: Chans,
    rate: u32,
}

/// What an edit did, for the page.
pub struct Outcome {
    pub sel: Sel,
    pub cursor: usize,
    pub msg: String,
    /// Index of the undo/redo step whose splices the page must apply, and in which direction.
    pub changes: Changes,
}

pub enum Changes {
    None,
    /// The newest undo step, applied forward.
    Forward,
    /// The newest redo step (just undone), applied backward.
    Backward,
}

#[derive(Default)]
pub struct Editor {
    pub chans: Chans,
    pub rate: u32,
    pub name: String,
    pub dirty: bool,
    undo: Vec<Step>,
    redo: Vec<Step>,
    clip: Option<Clip>,
}

impl Editor {
    pub fn load(&mut self, name: String, chans: Chans, rate: u32) {
        self.chans = chans;
        self.rate = rate;
        self.name = name;
        self.dirty = false;
        self.undo.clear();
        self.redo.clear();
    }

    pub fn has_doc(&self) -> bool {
        !self.chans.is_empty()
    }
    pub fn len(&self) -> usize {
        self.chans.first().map_or(0, Vec::len)
    }
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
    pub fn has_clip(&self) -> bool {
        self.clip.is_some()
    }

    /// The splices the page must apply after an edit, undo or redo.
    pub fn page_changes(&self, changes: &Changes) -> Vec<PageSplice<'_>> {
        match changes {
            Changes::None => Vec::new(),
            Changes::Forward => self.undo.last().map_or(Vec::new(), |s| {
                s.splices.iter().map(|sp| PageSplice { at: sp.at, remove: sp.old_len(), data: &sp.new }).collect()
            }),
            Changes::Backward => self.redo.last().map_or(Vec::new(), |s| {
                s.splices.iter().rev().map(|sp| PageSplice { at: sp.at, remove: sp.new_len(), data: &sp.old }).collect()
            }),
        }
    }

    // ---------- Low-level splicing ----------

    fn splice_in(chans: &mut Chans, at: usize, remove: usize, insert: &Chans) {
        for (c, ch) in chans.iter_mut().enumerate() {
            let ins = &insert[c % insert.len()];
            if ins.len() == remove {
                ch[at..at + remove].copy_from_slice(ins);
            } else {
                ch.splice(at..at + remove, ins.iter().copied());
            }
        }
    }

    /// Replace [start, end) with `new`, returning the splice for the history.
    fn replace(&mut self, start: usize, end: usize, new: Chans) -> Splice {
        let old: Chans = self.chans.iter().map(|ch| ch[start..end].to_vec()).collect();
        // Make the insert one-per-channel so undo/redo can reuse it directly.
        let n = self.chans.len();
        let new: Chans = if new.len() == n { new } else { (0..n).map(|c| new[c % new.len()].clone()).collect() };
        Self::splice_in(&mut self.chans, start, end - start, &new);
        Splice { at: start, old, new }
    }

    /// Transform [start, end) of every channel in place (fade, gain, ...).
    fn map_range(&mut self, start: usize, end: usize, f: impl Fn(&mut [f32])) -> Splice {
        let new: Chans = self
            .chans
            .iter()
            .map(|ch| {
                let mut part = ch[start..end].to_vec();
                f(&mut part);
                part
            })
            .collect();
        self.replace(start, end, new)
    }

    fn commit(&mut self, splices: Vec<Splice>, before: (Sel, usize), after: (Sel, usize), msg: String) -> Outcome {
        self.undo.push(Step { splices, before, after });
        if self.undo.len() > MAX_UNDO {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.dirty = true;
        Outcome { sel: after.0, cursor: after.1, msg, changes: Changes::Forward }
    }

    fn nothing(sel: Sel, cursor: usize, msg: &str) -> Outcome {
        Outcome { sel, cursor, msg: msg.into(), changes: Changes::None }
    }

    // ---------- Edits ----------

    /// Run one named edit. `sel` and `cursor` are the page's current selection and cursor.
    pub fn run(&mut self, op: &str, sel: Sel, cursor: usize, db: f64) -> Result<Outcome, String> {
        if !self.has_doc() {
            return Err("No file open".into());
        }
        let len = self.len();
        let sel = sel.map(|(s, e)| (s.min(len), e.min(len))).filter(|(s, e)| e > s);
        let cursor = cursor.min(len);
        let before = (sel, cursor);
        let range = sel.unwrap_or((0, len));

        Ok(match op {
            "undo" => self.undo_step(sel, cursor),
            "redo" => self.redo_step(sel, cursor),
            "copy" => match sel {
                Some((s, e)) => {
                    self.copy(s, e);
                    Self::nothing(sel, cursor, &format!("Copied {}", fmt_time(e - s, self.rate)))
                }
                None => Self::nothing(sel, cursor, ""),
            },
            "cut" | "delete" => match sel {
                Some((s, e)) => {
                    if op == "cut" {
                        self.copy(s, e);
                    }
                    let sp = self.replace(s, e, vec![Vec::new()]);
                    self.commit(vec![sp], before, (None, s), if op == "cut" { "Cut" } else { "Deleted" }.into())
                }
                None => Self::nothing(sel, cursor, ""),
            },
            "paste" => {
                let Some(clip) = &self.clip else { return Ok(Self::nothing(sel, cursor, "")) };
                let ins: Chans = if clip.rate == self.rate {
                    clip.chans.clone()
                } else {
                    clip.chans.iter().map(|c| resample(c, clip.rate, self.rate)).collect()
                };
                let n = ins[0].len();
                let (s, e) = sel.unwrap_or((cursor, cursor));
                let sp = self.replace(s, e, ins);
                self.commit(vec![sp], before, (Some((s, s + n)), s), "Pasted".into())
            }
            "trim" => match sel {
                Some((s, e)) => {
                    let tail = self.replace(e, len, vec![Vec::new()]);
                    let head = self.replace(0, s, vec![Vec::new()]);
                    self.commit(vec![tail, head], before, (None, 0), "Trimmed".into())
                }
                None => Self::nothing(sel, cursor, ""),
            },
            "silence" => match sel {
                Some((s, e)) => {
                    let sp = self.map_range(s, e, |p| p.fill(0.0));
                    self.commit(vec![sp], before, before, "Silenced".into())
                }
                None => Self::nothing(sel, cursor, ""),
            },
            "fadeIn" | "fadeOut" => {
                let (s, e) = range;
                let n = (e - s) as f32;
                let out = op == "fadeOut";
                let sp = self.map_range(s, e, |p| {
                    for (i, v) in p.iter_mut().enumerate() {
                        let t = i as f32 / n;
                        *v *= if out { 1.0 - t } else { t };
                    }
                });
                self.commit(vec![sp], before, before, if out { "Fade out" } else { "Fade in" }.into())
            }
            "reverse" => {
                let sp = self.map_range(range.0, range.1, |p| p.reverse());
                self.commit(vec![sp], before, before, "Reversed".into())
            }
            "normalize" => {
                let (s, e) = range;
                let peak = self.chans.iter().flat_map(|ch| ch[s..e].iter()).fold(0f32, |m, v| m.max(v.abs()));
                if peak == 0.0 {
                    return Ok(Self::nothing(sel, cursor, "Nothing to normalize (silence)"));
                }
                let g = 0.977 / peak; // about -0.2 dB
                let sp = self.map_range(s, e, |p| p.iter_mut().for_each(|v| *v *= g));
                self.commit(vec![sp], before, before, format!("Normalized (x{g:.2})"))
            }
            "gain" => {
                let g = 10f64.powf(db / 20.0) as f32;
                let sp = self.map_range(range.0, range.1, |p| p.iter_mut().for_each(|v| *v *= g));
                let sign = if db > 0.0 { "+" } else { "" };
                self.commit(vec![sp], before, before, format!("Gain {sign}{db} dB"))
            }
            other => return Err(format!("Unknown edit: {other}")),
        })
    }

    fn copy(&mut self, s: usize, e: usize) {
        self.clip = Some(Clip { chans: self.chans.iter().map(|ch| ch[s..e].to_vec()).collect(), rate: self.rate });
    }

    fn undo_step(&mut self, sel: Sel, cursor: usize) -> Outcome {
        let Some(step) = self.undo.pop() else { return Self::nothing(sel, cursor, "") };
        for sp in step.splices.iter().rev() {
            Self::splice_in(&mut self.chans, sp.at, sp.new_len(), &sp.old);
        }
        let (sel, cursor) = step.before;
        self.redo.push(step);
        self.dirty = true;
        Outcome { sel, cursor, msg: "Undo".into(), changes: Changes::Backward }
    }

    fn redo_step(&mut self, sel: Sel, cursor: usize) -> Outcome {
        let Some(step) = self.redo.pop() else { return Self::nothing(sel, cursor, "") };
        for sp in &step.splices {
            Self::splice_in(&mut self.chans, sp.at, sp.old_len(), &sp.new);
        }
        let (sel, cursor) = step.after;
        self.undo.push(step);
        self.dirty = true;
        Outcome { sel, cursor, msg: "Redo".into(), changes: Changes::Forward }
    }
}

/// Linear resampling, used when pasting audio from a file with another sample rate.
pub fn resample(src: &[f32], from: u32, to: u32) -> Vec<f32> {
    if src.is_empty() {
        return Vec::new();
    }
    let ratio = from as f64 / to as f64;
    let n = (src.len() as f64 / ratio).round() as usize;
    let last = src.len() - 1;
    (0..n)
        .map(|i| {
            let x = i as f64 * ratio;
            let i0 = (x.floor() as usize).min(last);
            let i1 = (i0 + 1).min(last);
            let t = (x - i0 as f64) as f32;
            src[i0] * (1.0 - t) + src[i1] * t
        })
        .collect()
}

/// m:ss.mmm, the same format the status bar uses.
pub fn fmt_time(samples: usize, rate: u32) -> String {
    let s = samples as f64 / rate.max(1) as f64;
    let m = (s / 60.0).floor();
    format!("{}:{:06.3}", m as u64, s - m * 60.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(v: &[f32]) -> Editor {
        let mut e = Editor::default();
        e.load("t".into(), vec![v.to_vec(), v.iter().map(|x| -x).collect()], 10);
        e
    }

    #[test]
    fn delete_undo_redo() {
        let mut e = doc(&[1., 2., 3., 4., 5.]);
        let o = e.run("delete", Some((1, 3)), 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![1., 4., 5.]);
        assert_eq!((o.sel, o.cursor), (None, 1));
        e.run("undo", None, 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![1., 2., 3., 4., 5.]);
        assert_eq!(e.chans[1], vec![-1., -2., -3., -4., -5.]);
        e.run("redo", None, 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![1., 4., 5.]);
    }

    #[test]
    fn trim_and_undo() {
        let mut e = doc(&[1., 2., 3., 4., 5.]);
        e.run("trim", Some((1, 3)), 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![2., 3.]);
        let o = e.run("undo", None, 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![1., 2., 3., 4., 5.]);
        assert_eq!(o.sel, Some((1, 3)));
    }

    #[test]
    fn copy_paste_over_selection() {
        let mut e = doc(&[1., 2., 3., 4., 5.]);
        e.run("copy", Some((0, 2)), 0, 0.).unwrap();
        let o = e.run("paste", Some((3, 5)), 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![1., 2., 3., 1., 2.]);
        assert_eq!(o.sel, Some((3, 5)));
        e.run("paste", None, 1, 0.).unwrap();
        assert_eq!(e.chans[0], vec![1., 1., 2., 2., 3., 1., 2.]);
        e.run("undo", None, 0, 0.).unwrap();
        e.run("undo", None, 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![1., 2., 3., 4., 5.]);
    }

    #[test]
    fn in_place_edits() {
        let mut e = doc(&[1., 1., 1., 1.]);
        e.run("fadeIn", None, 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![0., 0.25, 0.5, 0.75]);
        e.run("reverse", None, 0, 0.).unwrap();
        assert_eq!(e.chans[0], vec![0.75, 0.5, 0.25, 0.]);
        e.run("normalize", None, 0, 0.).unwrap();
        assert!((e.chans[0][0] - 0.977).abs() < 1e-6);
        e.run("silence", Some((0, 2)), 0, 0.).unwrap();
        assert_eq!(&e.chans[0][..2], &[0., 0.]);
        for _ in 0..4 {
            e.run("undo", None, 0, 0.).unwrap();
        }
        assert_eq!(e.chans[0], vec![1., 1., 1., 1.]);
    }

    #[test]
    fn page_changes_rebuild_the_mirror() {
        // Apply the page splices to a separate copy and check it tracks the editor.
        let mut e = doc(&[1., 2., 3., 4., 5., 6.]);
        let mut mirror = e.chans.clone();
        let apply = |m: &mut Chans, e: &Editor, c: &Changes| {
            for p in e.page_changes(c) {
                Editor::splice_in(m, p.at, p.remove, p.data);
            }
        };
        for (op, sel) in [("trim", Some((1, 5))), ("copy", Some((0, 2))), ("paste", None), ("gain", None)] {
            let o = e.run(op, sel, 1, 6.).unwrap();
            apply(&mut mirror, &e, &o.changes);
            assert_eq!(mirror, e.chans, "after {op}");
        }
        for op in ["undo", "undo", "redo", "undo", "undo"] {
            let o = e.run(op, None, 0, 0.).unwrap();
            apply(&mut mirror, &e, &o.changes);
            assert_eq!(mirror, e.chans, "after {op}");
        }
    }

    #[test]
    fn paste_resamples() {
        let mut e = doc(&[0., 1., 0., 1.]);
        e.run("copy", Some((0, 4)), 0, 0.).unwrap();
        e.rate = 20;
        e.run("paste", None, 0, 0.).unwrap();
        assert_eq!(e.len(), 12);
    }
}
