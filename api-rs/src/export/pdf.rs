//! A small page layout engine on top of krilla: headings (with a QR code),
//! paragraphs, key/value lists, tables that wrap and repeat their header,
//! rack elevations, a contents page and PDF bookmarks. Text is measured
//! with the embedded DejaVu fonts, so line breaks and truncation are exact.

use krilla::color::rgb;
use krilla::destination::XyzDestination;
use krilla::geom::{PathBuilder, Point, Rect};
use krilla::metadata::Metadata;
use krilla::num::NormalizedF32;
use krilla::outline::{Outline, OutlineNode};
use krilla::page::PageSettings;
use krilla::paint::{Fill, FillRule, Stroke};
use krilla::text::{Font as KFont, TextDirection};
use krilla::Document;

pub const PAGE_W: f32 = 595.28;
pub const PAGE_H: f32 = 841.89;
pub const MARGIN: f32 = 48.0;
const BOTTOM: f32 = PAGE_H - MARGIN - 16.0; // room for the footer
pub const CONTENT_W: f32 = PAGE_W - 2.0 * MARGIN;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Face {
    Regular,
    Bold,
    Mono,
}

pub type Color = [u8; 3];
pub const TEXT: Color = [17, 24, 39];
pub const MUTED: Color = [100, 116, 139];
pub const LINE: Color = [203, 213, 225];
pub const SHADE: Color = [241, 245, 249];
pub const ACCENT: Color = [14, 116, 144];

#[derive(Clone, Debug)]
enum Op {
    Text {
        x: f32,
        y: f32,
        size: f32,
        face: Face,
        color: Color,
        text: String,
    },
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        fill: Option<Color>,
        stroke: Option<Color>,
    },
    Qr {
        x: f32,
        y: f32,
        size: f32,
        width: usize,
        dark: Vec<bool>,
    },
}

pub struct Fonts {
    faces: [ttf_parser::Face<'static>; 3],
}

fn font_data(face: Face) -> &'static [u8] {
    match face {
        Face::Regular => dejavu::sans::regular(),
        Face::Bold => dejavu::sans::bold(),
        Face::Mono => dejavu::sans_mono::regular(),
    }
}

impl Fonts {
    pub fn new() -> Fonts {
        let f = |face| ttf_parser::Face::parse(font_data(face), 0).expect("embedded font");
        Fonts {
            faces: [f(Face::Regular), f(Face::Bold), f(Face::Mono)],
        }
    }
    fn face(&self, f: Face) -> &ttf_parser::Face<'static> {
        &self.faces[f as usize]
    }
    /// Width of `text` in points.
    pub fn width(&self, f: Face, size: f32, text: &str) -> f32 {
        let face = self.face(f);
        let upem = face.units_per_em() as f32;
        let units: u32 = text
            .chars()
            .map(|c| {
                face.glyph_index(c)
                    .and_then(|g| face.glyph_hor_advance(g))
                    .unwrap_or(upem as u16 / 2) as u32
            })
            .sum();
        units as f32 * size / upem
    }
    /// `text` cut to `max` points, with an ellipsis when cut.
    pub fn fit(&self, f: Face, size: f32, text: &str, max: f32) -> String {
        if self.width(f, size, text) <= max {
            return text.to_string();
        }
        let mut out = String::new();
        for c in text.chars() {
            let mut next = out.clone();
            next.push(c);
            next.push('…');
            if self.width(f, size, &next) > max {
                break;
            }
            out.push(c);
        }
        out.push('…');
        out
    }
    /// Lines of `text` wrapped to `max` points.
    pub fn wrap(&self, f: Face, size: f32, text: &str, max: f32) -> Vec<String> {
        let mut lines = Vec::new();
        for para in text.split('\n') {
            let mut line = String::new();
            for word in para.split_whitespace() {
                let candidate = if line.is_empty() {
                    word.to_string()
                } else {
                    format!("{line} {word}")
                };
                if self.width(f, size, &candidate) <= max {
                    line = candidate;
                    continue;
                }
                if !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                }
                // A word wider than the column is broken by characters.
                let mut piece = String::new();
                for c in word.chars() {
                    let mut next = piece.clone();
                    next.push(c);
                    if self.width(f, size, &next) > max && !piece.is_empty() {
                        lines.push(std::mem::take(&mut piece));
                        next = c.to_string();
                    }
                    piece = next;
                }
                line = piece;
            }
            lines.push(line);
        }
        lines
    }
}

impl Default for Fonts {
    fn default() -> Self {
        Fonts::new()
    }
}

pub struct TocEntry {
    pub level: u8,
    pub title: String,
    pub page: usize,
    pub y: f32,
}

/// A document being laid out.
pub struct Doc {
    pub fonts: Fonts,
    pages: Vec<Vec<Op>>,
    y: f32,
    pub toc: Vec<TocEntry>,
}

impl Doc {
    pub fn new() -> Doc {
        Doc {
            fonts: Fonts::new(),
            pages: vec![vec![]],
            y: MARGIN,
            toc: vec![],
        }
    }
    fn ops(&mut self) -> &mut Vec<Op> {
        self.pages.last_mut().expect("a page")
    }
    pub fn page_break(&mut self) {
        if !self.ops().is_empty() {
            self.pages.push(vec![]);
        }
        self.y = MARGIN;
    }
    /// Starts a new page unless `h` points still fit.
    pub fn need(&mut self, h: f32) {
        if self.y + h > BOTTOM {
            self.page_break();
        }
    }
    pub fn gap(&mut self, h: f32) {
        self.y += h;
    }
    pub fn text(&mut self, x: f32, y: f32, size: f32, face: Face, color: Color, text: &str) {
        if !text.is_empty() {
            self.ops().push(Op::Text {
                x,
                y,
                size,
                face,
                color,
                text: text.to_string(),
            });
        }
    }
    pub fn rect(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        fill: Option<Color>,
        stroke: Option<Color>,
    ) {
        self.ops().push(Op::Rect {
            x,
            y,
            w,
            h,
            fill,
            stroke,
        });
    }

    /// A section heading (level 1–4), listed in the contents, with an
    /// optional QR code linking to the page in Rackpath.
    pub fn heading(&mut self, level: u8, title: &str, subtitle: Option<&str>, qr: Option<&str>) {
        let size: f32 = match level {
            1 => 18.0,
            2 => 14.5,
            3 => 12.0,
            _ => 10.5,
        };
        let qr_size: f32 = if qr.is_some() { 54.0 } else { 0.0 };
        let block = (size * 1.4 + if subtitle.is_some() { 14.0 } else { 0.0 }).max(qr_size) + 6.0;
        if level == 1 {
            self.page_break();
        } else {
            self.need(block + 40.0);
            self.gap(if level == 2 { 10.0 } else { 6.0 });
        }
        let top = self.y;
        let text_w = CONTENT_W - if qr.is_some() { qr_size + 10.0 } else { 0.0 };
        let shown = self.fonts.fit(Face::Bold, size, title, text_w);
        self.toc.push(TocEntry {
            level,
            title: title.to_string(),
            page: self.pages.len() - 1,
            y: top,
        });
        self.text(
            MARGIN,
            top + size,
            size,
            Face::Bold,
            if level <= 2 { ACCENT } else { TEXT },
            &shown,
        );
        if let Some(s) = subtitle {
            let s = self.fonts.fit(Face::Regular, 9.0, s, text_w);
            self.text(MARGIN, top + size + 14.0, 9.0, Face::Regular, MUTED, &s);
        }
        if let Some(url) = qr {
            self.qr(PAGE_W - MARGIN - qr_size, top, qr_size, url);
        }
        self.y = top + block;
        if level <= 2 {
            self.rect(MARGIN, self.y - 3.0, CONTENT_W, 0.6, Some(LINE), None);
            self.gap(4.0);
        }
    }

    pub fn qr(&mut self, x: f32, y: f32, size: f32, data: &str) {
        if let Ok(code) = qrcode::QrCode::new(data.as_bytes()) {
            let dark = code
                .to_colors()
                .into_iter()
                .map(|c| c == qrcode::Color::Dark)
                .collect();
            self.ops().push(Op::Qr {
                x,
                y,
                size,
                width: code.width(),
                dark,
            });
        }
    }

    pub fn para(&mut self, text: &str, size: f32, color: Color) {
        for line in self.fonts.wrap(Face::Regular, size, text, CONTENT_W) {
            self.need(size * 1.35);
            self.text(MARGIN, self.y + size, size, Face::Regular, color, &line);
            self.y += size * 1.35;
        }
        self.gap(4.0);
    }

    /// Two columns: muted keys, wrapped values. Empty values are left out.
    pub fn key_values(&mut self, rows: &[(&str, String)]) {
        let size = 9.0;
        let key_w = 120.0;
        for (k, v) in rows.iter().filter(|(_, v)| !v.trim().is_empty()) {
            let lines = self.fonts.wrap(Face::Regular, size, v, CONTENT_W - key_w);
            self.need(lines.len() as f32 * size * 1.35);
            self.text(MARGIN, self.y + size, size, Face::Regular, MUTED, k);
            for line in lines {
                self.text(
                    MARGIN + key_w,
                    self.y + size,
                    size,
                    Face::Regular,
                    TEXT,
                    &line,
                );
                self.y += size * 1.35;
            }
        }
        self.gap(6.0);
    }

    /// A table: columns as (title, share of the width, monospace?).
    pub fn table(&mut self, cols: &[(&str, f32, bool)], rows: &[Vec<String>]) {
        let size = 8.0;
        let pad = 3.0;
        let total: f32 = cols.iter().map(|c| c.1).sum();
        let widths: Vec<f32> = cols.iter().map(|c| c.1 / total * CONTENT_W).collect();
        let header = |doc: &mut Doc| {
            let h = size + 2.0 * pad + 2.0;
            doc.rect(MARGIN, doc.y, CONTENT_W, h, Some(SHADE), None);
            let mut x = MARGIN;
            for (i, (title, _, _)) in cols.iter().enumerate() {
                let t = doc
                    .fonts
                    .fit(Face::Bold, size, title, widths[i] - 2.0 * pad);
                doc.text(x + pad, doc.y + pad + size, size, Face::Bold, TEXT, &t);
                x += widths[i];
            }
            doc.y += h;
        };
        self.need(40.0);
        header(self);
        for (n, row) in rows.iter().enumerate() {
            let cells: Vec<Vec<String>> = row
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    let face = if cols.get(i).is_some_and(|c| c.2) {
                        Face::Mono
                    } else {
                        Face::Regular
                    };
                    self.fonts.wrap(
                        face,
                        size,
                        v,
                        widths.get(i).copied().unwrap_or(50.0) - 2.0 * pad,
                    )
                })
                .collect();
            let lines = cells.iter().map(Vec::len).max().unwrap_or(1).max(1);
            let h = lines as f32 * size * 1.3 + 2.0 * pad;
            if self.y + h > BOTTOM {
                self.page_break();
                header(self);
            }
            if n % 2 == 1 {
                self.rect(MARGIN, self.y, CONTENT_W, h, Some([248, 250, 252]), None);
            }
            let mut x = MARGIN;
            for (i, lines) in cells.iter().enumerate() {
                let face = if cols.get(i).is_some_and(|c| c.2) {
                    Face::Mono
                } else {
                    Face::Regular
                };
                for (l, line) in lines.iter().enumerate() {
                    self.text(
                        x + pad,
                        self.y + pad + size + l as f32 * size * 1.3,
                        size,
                        face,
                        TEXT,
                        line,
                    );
                }
                x += widths.get(i).copied().unwrap_or(0.0);
            }
            self.y += h;
            self.rect(MARGIN, self.y, CONTENT_W, 0.4, Some(LINE), None);
        }
        self.gap(8.0);
    }

    /// Front and rear elevations side by side. `items` are (lowest U,
    /// height in U, face "front"/"rear"/"both", label); half-U positions
    /// are drawn where they sit.
    pub fn elevation(
        &mut self,
        u_height: i64,
        top_down: bool,
        items: &[(f64, f64, String, String)],
    ) {
        let u_h = (420.0 / u_height.max(1) as f32).clamp(6.0, 11.0);
        let total = u_h * u_height as f32;
        self.need(total + 30.0);
        let col_w = (CONTENT_W - 60.0) / 2.0;
        let label = |n: i64| if top_down { u_height - n + 1 } else { n };
        for (i, face) in ["front", "rear"].iter().enumerate() {
            let x = MARGIN + 20.0 + i as f32 * (col_w + 20.0);
            let top = self.y + 12.0;
            self.text(
                x,
                self.y + 8.0,
                8.0,
                Face::Bold,
                MUTED,
                if i == 0 { "Front" } else { "Rear" },
            );
            self.rect(x, top, col_w, total, Some([250, 250, 250]), Some(LINE));
            for n in 1..=u_height {
                let y = top + total - n as f32 * u_h;
                self.rect(x, y, col_w, 0.3, Some(LINE), None);
                if u_h >= 7.0 && (n % 2 == 1 || u_h >= 9.0) {
                    self.text(
                        x - 16.0,
                        y + u_h - 1.5,
                        6.0,
                        Face::Mono,
                        MUTED,
                        &label(n).to_string(),
                    );
                }
            }
            for (u, h, f, text) in items {
                if f != face && f != "both" {
                    continue;
                }
                let y = top + total - ((*u - 1.0 + *h) as f32) * u_h;
                let hh = (*h as f32 * u_h).max(u_h / 2.0);
                self.rect(
                    x + 1.0,
                    y + 0.5,
                    col_w - 2.0,
                    hh - 1.0,
                    Some([224, 242, 254]),
                    Some(ACCENT),
                );
                let size = (hh - 2.0).clamp(4.0, 7.5);
                let t = self.fonts.fit(Face::Regular, size, text, col_w - 6.0);
                self.text(
                    x + 3.0,
                    y + (hh + size) / 2.0 - 0.5,
                    size,
                    Face::Regular,
                    TEXT,
                    &t,
                );
            }
        }
        self.y += total + 24.0;
    }

    /// Writes the PDF: a cover, the contents, then the pages laid out,
    /// with page numbers and bookmarks.
    pub fn finish(
        self,
        title: &str,
        cover: &[(&str, String)],
        footer: &str,
        url: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        let fonts = self.fonts;
        // Contents: two-column lines, 46 per page.
        let toc_lines: Vec<&TocEntry> = self.toc.iter().filter(|t| t.level <= 3).collect();
        let toc_pages = toc_lines.len().div_ceil(46).max(1);
        let offset = 1 + toc_pages;
        let mut pages: Vec<Vec<Op>> = Vec::new();
        // Cover.
        let mut c = vec![
            Op::Rect {
                x: 0.0,
                y: 0.0,
                w: PAGE_W,
                h: 8.0,
                fill: Some(ACCENT),
                stroke: None,
            },
            Op::Text {
                x: MARGIN,
                y: 200.0,
                size: 11.0,
                face: Face::Bold,
                color: ACCENT,
                text: "RACKPATH REPORT".into(),
            },
        ];
        let mut y = 232.0;
        for line in fonts.wrap(Face::Bold, 24.0, title, CONTENT_W) {
            c.push(Op::Text {
                x: MARGIN,
                y,
                size: 24.0,
                face: Face::Bold,
                color: TEXT,
                text: line,
            });
            y += 30.0;
        }
        y += 20.0;
        for (k, v) in cover {
            c.push(Op::Text {
                x: MARGIN,
                y,
                size: 10.0,
                face: Face::Regular,
                color: MUTED,
                text: (*k).to_string(),
            });
            c.push(Op::Text {
                x: MARGIN + 110.0,
                y,
                size: 10.0,
                face: Face::Regular,
                color: TEXT,
                text: fonts.fit(Face::Regular, 10.0, v, CONTENT_W - 110.0),
            });
            y += 16.0;
        }
        if let Some(u) = url {
            if let Ok(code) = qrcode::QrCode::new(u.as_bytes()) {
                c.push(Op::Qr {
                    x: MARGIN,
                    y: y + 20.0,
                    size: 90.0,
                    width: code.width(),
                    dark: code
                        .to_colors()
                        .into_iter()
                        .map(|x| x == qrcode::Color::Dark)
                        .collect(),
                });
            }
        }
        pages.push(c);
        // Contents pages.
        for chunk in 0..toc_pages {
            let mut p = vec![Op::Text {
                x: MARGIN,
                y: MARGIN + 18.0,
                size: 18.0,
                face: Face::Bold,
                color: ACCENT,
                text: "Contents".into(),
            }];
            let mut y = MARGIN + 46.0;
            for t in toc_lines.iter().skip(chunk * 46).take(46) {
                let indent = (t.level as f32 - 1.0) * 14.0;
                let face = if t.level == 1 {
                    Face::Bold
                } else {
                    Face::Regular
                };
                let num = (t.page + offset + 1).to_string();
                let max = CONTENT_W - indent - 40.0;
                p.push(Op::Text {
                    x: MARGIN + indent,
                    y,
                    size: 9.5,
                    face,
                    color: TEXT,
                    text: fonts.fit(face, 9.5, &t.title, max),
                });
                p.push(Op::Text {
                    x: PAGE_W - MARGIN - fonts.width(Face::Regular, 9.5, &num),
                    y,
                    size: 9.5,
                    face: Face::Regular,
                    color: MUTED,
                    text: num,
                });
                y += 15.0;
            }
            pages.push(p);
        }
        pages.extend(self.pages);
        let total = pages.len();

        let mut doc = Document::new();
        let kfont = |f: Face| KFont::new(font_data(f).into(), 0).expect("embedded font");
        let kf = [kfont(Face::Regular), kfont(Face::Bold), kfont(Face::Mono)];
        for (n, ops) in pages.iter().enumerate() {
            let mut page = doc.start_page_with(PageSettings::from_wh(PAGE_W, PAGE_H).expect("A4"));
            let mut s = page.surface();
            for op in ops {
                match op {
                    Op::Text {
                        x,
                        y,
                        size,
                        face,
                        color,
                        text,
                    } => {
                        s.set_fill(Some(fill(*color)));
                        s.draw_text(
                            Point::from_xy(*x, *y),
                            kf[*face as usize].clone(),
                            *size,
                            text,
                            false,
                            TextDirection::Auto,
                        );
                    }
                    Op::Rect {
                        x,
                        y,
                        w,
                        h,
                        fill: f,
                        stroke,
                    } => {
                        let Some(rect) = Rect::from_xywh(*x, *y, w.max(0.1), h.max(0.1)) else {
                            continue;
                        };
                        let mut pb = PathBuilder::new();
                        pb.push_rect(rect);
                        let Some(path) = pb.finish() else { continue };
                        s.set_fill(f.map(fill));
                        s.set_stroke(stroke.map(|c| Stroke {
                            paint: rgb::Color::new(c[0], c[1], c[2]).into(),
                            width: 0.6,
                            ..Default::default()
                        }));
                        s.draw_path(&path);
                        s.set_stroke(None);
                    }
                    Op::Qr {
                        x,
                        y,
                        size,
                        width,
                        dark,
                    } => {
                        let m = size / (*width as f32 + 2.0);
                        let mut pb = PathBuilder::new();
                        for (i, d) in dark.iter().enumerate() {
                            if *d {
                                let (cx, cy) = ((i % width) as f32 + 1.0, (i / width) as f32 + 1.0);
                                if let Some(r) =
                                    Rect::from_xywh(x + cx * m, y + cy * m, m + 0.05, m + 0.05)
                                {
                                    pb.push_rect(r);
                                }
                            }
                        }
                        if let Some(path) = pb.finish() {
                            s.set_fill(Some(fill([0, 0, 0])));
                            s.draw_path(&path);
                        }
                    }
                }
            }
            if n > 0 {
                let label = format!("{footer} · page {} of {total}", n + 1);
                s.set_fill(Some(fill(MUTED)));
                s.draw_text(
                    Point::from_xy(MARGIN, PAGE_H - MARGIN + 14.0),
                    kf[0].clone(),
                    7.5,
                    &fonts.fit(Face::Regular, 7.5, &label, CONTENT_W),
                    false,
                    TextDirection::Auto,
                );
            }
            s.finish();
            page.finish();
        }
        // Bookmarks: levels 1 and 2, nested.
        let mut outline = Outline::new();
        let mut current: Option<OutlineNode> = None;
        for t in self.toc.iter().filter(|t| t.level <= 2) {
            let node = OutlineNode::new(
                t.title.clone(),
                XyzDestination::new(t.page + offset, Point::from_xy(0.0, t.y)),
            );
            if t.level == 1 {
                if let Some(done) = current.take() {
                    outline.push_child(done);
                }
                current = Some(node);
            } else if let Some(parent) = current.as_mut() {
                parent.push_child(node);
            } else {
                outline.push_child(node);
            }
        }
        if let Some(done) = current {
            outline.push_child(done);
        }
        doc.set_outline(outline);
        doc.set_metadata(
            Metadata::new()
                .title(title.to_string())
                .creator("Rackpath".into()),
        );
        doc.finish().map_err(|e| format!("PDF: {e:?}"))
    }
}

impl Default for Doc {
    fn default() -> Self {
        Doc::new()
    }
}

fn fill(c: Color) -> Fill {
    Fill {
        paint: rgb::Color::new(c[0], c[1], c[2]).into(),
        opacity: NormalizedF32::ONE,
        rule: FillRule::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_measured_wrapped_and_fitted() {
        let f = Fonts::new();
        let w = f.width(Face::Regular, 10.0, "Rackpath");
        assert!(w > 30.0 && w < 60.0, "{w}");
        assert!(f.width(Face::Bold, 10.0, "Rackpath") > w);
        let lines = f.wrap(
            Face::Regular,
            10.0,
            "one two three four five six seven",
            60.0,
        );
        assert!(
            lines.len() > 2
                && lines
                    .iter()
                    .all(|l| f.width(Face::Regular, 10.0, l) <= 60.0)
        );
        assert!(
            f.wrap(Face::Regular, 10.0, "averyveryverylongunbrokenword", 40.0)
                .len()
                > 2
        );
        let cut = f.fit(Face::Regular, 10.0, "a long label that won't fit", 50.0);
        assert!(cut.ends_with('…') && f.width(Face::Regular, 10.0, &cut) <= 50.0);
    }

    #[test]
    fn a_document_becomes_a_pdf_with_contents_and_qr() {
        let mut d = Doc::new();
        d.heading(
            1,
            "HQ",
            Some("Headquarters"),
            Some("https://rackpath.example/r/location/1"),
        );
        d.key_values(&[("Address", "1 High St".into()), ("Empty", String::new())]);
        d.heading(
            2,
            "Rack RK01",
            None,
            Some("https://rackpath.example/r/rack/1"),
        );
        d.elevation(
            42,
            false,
            &[
                (10.0, 1.0, "front".into(), "SW01 core".into()),
                (20.0, 2.0, "both".into(), "SRV01".into()),
            ],
        );
        let rows: Vec<Vec<String>> = (0..120)
            .map(|i| {
                vec![
                    format!("P{i}"),
                    "RJ45".into(),
                    "A long path that wraps across the column".into(),
                ]
            })
            .collect();
        d.table(
            &[
                ("Port", 1.0, true),
                ("Media", 1.0, false),
                ("Cable", 3.0, false),
            ],
            &rows,
        );
        let pdf = d
            .finish(
                "HQ report",
                &[("Project", "ACME".into())],
                "ACME/HQ",
                Some("https://rackpath.example/r/location/1"),
            )
            .unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(pdf.len() > 10_000);
    }
}
