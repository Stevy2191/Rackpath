//! Device templates (design section 7): port groups laid out on a grid,
//! and the ports they generate. Pure, unit-tested.
//!
//! Each face is a grid with two port rows per rack unit and 48 columns (a
//! 19" face). A group is a rectangle of ports on one face. Groups with the
//! same prefix share one numbering sequence, counted left to right, front
//! before rear. Inside a group, ports are numbered top-to-bottom first
//! (`column_major`, the usual switch layout: 1 above 2) or left-to-right
//! first (`row_major`).

use std::collections::{HashMap, HashSet};

pub const MAX_COLS: u16 = 48;
pub const MAX_PORTS_PER_GROUP: u32 = 99;
pub const MAX_PREFIX: usize = 4;
pub const MAX_CODE: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Face {
    Front,
    Rear,
}

impl Face {
    pub fn as_str(self) -> &'static str {
        match self {
            Face::Front => "front",
            Face::Rear => "rear",
        }
    }
    pub fn parse(s: &str) -> Option<Face> {
        match s {
            "front" => Some(Face::Front),
            "rear" => Some(Face::Rear),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Numbering {
    ColumnMajor,
    RowMajor,
}

impl Numbering {
    pub fn as_str(self) -> &'static str {
        match self {
            Numbering::ColumnMajor => "column_major",
            Numbering::RowMajor => "row_major",
        }
    }
    pub fn parse(s: &str) -> Option<Numbering> {
        match s {
            "column_major" => Some(Numbering::ColumnMajor),
            "row_major" => Some(Numbering::RowMajor),
            _ => None,
        }
    }
}

/// Where and how a group sits; its port attributes are kept by the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub face: Face,
    pub grid_row: u16,
    pub grid_col: u16,
    pub rows: u16,
    pub cols: u16,
    pub prefix: String,
    pub numbering: Numbering,
    /// First number of this group's sequence when it's the first group with
    /// its prefix (usually 1).
    pub start: u32,
}

/// The grid of one face: rows and columns available.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grid {
    pub rows: u16,
    pub cols: u16,
}

/// Grid size for a template's height, in half-U steps: two port rows per
/// U, so one row per half U. Zero-U devices (vertical PDUs) are a tall,
/// narrow strip; devices that aren't rack-mounted get a small panel.
pub fn grid_for(u_height_half: Option<i64>) -> Grid {
    match u_height_half {
        None => Grid {
            rows: 8,
            cols: MAX_COLS,
        },
        Some(0) => Grid { rows: 120, cols: 4 },
        Some(h) => Grid {
            rows: h.clamp(1, 120) as u16,
            cols: MAX_COLS,
        },
    }
}

/// One generated port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Generated {
    /// Position in generation order (what overrides refer to).
    pub index: usize,
    /// Index of the group (in the caller's order) it came from.
    pub group: usize,
    pub code: String,
    pub face: Face,
    pub row: u16,
    pub col: u16,
}

fn valid_code_chars(s: &str) -> bool {
    s.chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

/// Normalises a prefix (uppercase, at most 4 characters, may be empty).
pub fn normalize_prefix(p: &str) -> Result<String, String> {
    let p = p.trim().to_ascii_uppercase();
    if p.len() > MAX_PREFIX || !valid_code_chars(&p) {
        return Err(format!(
            "A port prefix is at most {MAX_PREFIX} characters of A-Z, 0-9, '.', '_' or '-'"
        ));
    }
    Ok(p)
}

/// Checks the groups against the grid and each other, then generates the
/// ports with their codes (overrides applied by generation index).
pub fn generate(
    groups: &[Group],
    overrides: &[(usize, String)],
    grid: Grid,
) -> Result<Vec<Generated>, String> {
    for (i, g) in groups.iter().enumerate() {
        let n = i + 1;
        if g.rows == 0 || g.cols == 0 {
            return Err(format!("Group {n} has no ports"));
        }
        if u32::from(g.rows) * u32::from(g.cols) > MAX_PORTS_PER_GROUP {
            return Err(format!(
                "Group {n} has more than {MAX_PORTS_PER_GROUP} ports; split it"
            ));
        }
        if g.grid_row + g.rows > grid.rows || g.grid_col + g.cols > grid.cols {
            return Err(format!(
                "Group {n} doesn't fit the {} face ({} rows by {} columns)",
                g.face.as_str(),
                grid.rows,
                grid.cols
            ));
        }
        if g.prefix.len() > MAX_PREFIX || !valid_code_chars(&g.prefix) {
            return Err(format!("Group {n} has an invalid prefix"));
        }
        if g.start > 99_999 {
            return Err(format!("Group {n} starts numbering too high"));
        }
        for (j, h) in groups.iter().enumerate().take(i) {
            let overlap = g.face == h.face
                && g.grid_row < h.grid_row + h.rows
                && h.grid_row < g.grid_row + g.rows
                && g.grid_col < h.grid_col + h.cols
                && h.grid_col < g.grid_col + g.cols;
            if overlap {
                return Err(format!("Groups {} and {n} overlap", j + 1));
            }
        }
    }

    // Numbering order: front before rear, then left to right, then top down.
    let mut order: Vec<usize> = (0..groups.len()).collect();
    order.sort_by_key(|&i| {
        let g = &groups[i];
        (g.face, g.grid_col, g.grid_row)
    });
    let mut next: HashMap<&str, u32> = HashMap::new();
    let mut out = Vec::new();
    for &gi in &order {
        let g = &groups[gi];
        let counter = next.entry(g.prefix.as_str()).or_insert(g.start);
        let cells: Vec<(u16, u16)> = match g.numbering {
            Numbering::ColumnMajor => (0..g.cols)
                .flat_map(|c| (0..g.rows).map(move |r| (r, c)))
                .collect(),
            Numbering::RowMajor => (0..g.rows)
                .flat_map(|r| (0..g.cols).map(move |c| (r, c)))
                .collect(),
        };
        for (r, c) in cells {
            out.push(Generated {
                index: out.len(),
                group: gi,
                code: format!("{}{}", g.prefix, counter),
                face: g.face,
                row: g.grid_row + r,
                col: g.grid_col + c,
            });
            *counter += 1;
        }
    }

    for (index, code) in overrides {
        let code = code.trim().to_ascii_uppercase();
        let port = out
            .get_mut(*index)
            .ok_or_else(|| format!("There's no port number {} to rename", index + 1))?;
        if code.is_empty() || code.len() > MAX_CODE || !valid_code_chars(&code) {
            return Err(format!(
                "Custom port names are 1 to {MAX_CODE} characters of A-Z, 0-9, '.', '_' or '-'"
            ));
        }
        port.code = code;
    }
    let mut seen = HashSet::new();
    for p in &out {
        if p.code.len() > MAX_CODE {
            return Err(format!(
                "Port code {} is longer than {MAX_CODE} characters",
                p.code
            ));
        }
        if !seen.insert(p.code.as_str()) {
            return Err(format!(
                "Two ports would both be called {}; use different prefixes or rename one",
                p.code
            ));
        }
    }
    Ok(out)
}

/// What changes on a device when its template changes, matched by code.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PortDiff {
    /// Codes of generated ports that are new.
    pub added: Vec<String>,
    /// (existing port id, code) for ports that stay.
    pub kept: Vec<(i64, String)>,
    /// (existing port id, code) for ports that disappear.
    pub removed: Vec<(i64, String)>,
}

/// Compares a device's template-generated ports with a new generation.
pub fn diff(existing: &[(i64, String)], generated: &[Generated]) -> PortDiff {
    let new: HashSet<&str> = generated.iter().map(|g| g.code.as_str()).collect();
    let old: HashSet<&str> = existing.iter().map(|(_, c)| c.as_str()).collect();
    let mut d = PortDiff::default();
    for (id, code) in existing {
        if new.contains(code.as_str()) {
            d.kept.push((*id, code.clone()));
        } else {
            d.removed.push((*id, code.clone()));
        }
    }
    for g in generated {
        if !old.contains(g.code.as_str()) {
            d.added.push(g.code.clone());
        }
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(face: Face, row: u16, col: u16, rows: u16, cols: u16, prefix: &str) -> Group {
        Group {
            face,
            grid_row: row,
            grid_col: col,
            rows,
            cols,
            prefix: prefix.into(),
            numbering: Numbering::ColumnMajor,
            start: 1,
        }
    }

    fn codes(g: &[Generated]) -> Vec<&str> {
        g.iter().map(|p| p.code.as_str()).collect()
    }

    #[test]
    fn switch_layout_numbers_top_then_bottom() {
        // 1U: 2 rows. 24 ports in 2 rows of 12, then 4 uplinks.
        let groups = [
            group(Face::Front, 0, 0, 2, 12, ""),
            group(Face::Front, 0, 40, 2, 2, "X"),
        ];
        let p = generate(&groups, &[], grid_for(Some(2))).unwrap();
        assert_eq!(p.len(), 28);
        assert_eq!(&codes(&p)[..4], ["1", "2", "3", "4"]);
        assert_eq!((p[0].row, p[0].col), (0, 0));
        assert_eq!((p[1].row, p[1].col), (1, 0), "2 sits below 1");
        assert_eq!((p[2].row, p[2].col), (0, 1));
        assert_eq!(&codes(&p)[24..], ["X1", "X2", "X3", "X4"]);
    }

    #[test]
    fn row_major_and_shared_prefixes() {
        let mut a = group(Face::Front, 0, 0, 2, 3, "P");
        a.numbering = Numbering::RowMajor;
        let b = group(Face::Front, 0, 10, 1, 2, "P");
        let c = group(Face::Rear, 0, 0, 1, 2, "P");
        // Given out of order: numbering still runs front-left first.
        let p = generate(&[c, b, a], &[], grid_for(Some(2))).unwrap();
        assert_eq!(
            codes(&p),
            ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"]
        );
        assert_eq!((p[1].row, p[1].col), (0, 1), "row major: 2 beside 1");
        assert_eq!(p[6].group, 1);
        assert_eq!(p[8].face, Face::Rear);
    }

    #[test]
    fn overrides_rename_ports() {
        let g = [group(Face::Rear, 0, 0, 1, 2, "PSU")];
        let p = generate(
            &g,
            &[(0, "psu-a".into()), (1, "PSU-B".into())],
            grid_for(Some(2)),
        )
        .unwrap();
        assert_eq!(codes(&p), ["PSU-A", "PSU-B"]);
        assert!(generate(&g, &[(5, "X".into())], grid_for(Some(2))).is_err());
        assert!(
            generate(&g, &[(0, "PSU2".into())], grid_for(Some(2))).is_err(),
            "duplicate"
        );
        assert!(generate(&g, &[(0, "TOO-LONG-NAME".into())], grid_for(Some(2))).is_err());
    }

    #[test]
    fn groups_are_checked() {
        let grid = grid_for(Some(2)); // 2 rows x 48
        assert!(
            generate(&[group(Face::Front, 0, 0, 3, 1, "")], &[], grid).is_err(),
            "too tall"
        );
        assert!(
            generate(&[group(Face::Front, 0, 40, 1, 10, "")], &[], grid).is_err(),
            "too wide"
        );
        assert!(
            generate(&[group(Face::Front, 0, 0, 2, 0, "")], &[], grid).is_err(),
            "empty"
        );
        let big = Grid {
            rows: 120,
            cols: 48,
        };
        assert!(
            generate(&[group(Face::Front, 0, 0, 10, 10, "")], &[], big).is_err(),
            "100 ports"
        );
        let e = generate(
            &[
                group(Face::Front, 0, 0, 2, 4, ""),
                group(Face::Front, 1, 3, 1, 2, "U"),
            ],
            &[],
            grid,
        )
        .unwrap_err();
        assert!(e.contains("overlap"), "{e}");
        // Same spot on the other face is fine.
        assert!(generate(
            &[
                group(Face::Front, 0, 0, 2, 4, ""),
                group(Face::Rear, 0, 0, 2, 4, "R")
            ],
            &[],
            grid
        )
        .is_ok());
        // Same prefix in two groups numbers on; two empty-prefix groups too.
        let p = generate(
            &[
                group(Face::Front, 0, 0, 1, 2, ""),
                group(Face::Rear, 0, 0, 1, 2, ""),
            ],
            &[],
            grid,
        )
        .unwrap();
        assert_eq!(codes(&p), ["1", "2", "3", "4"]);
        assert!(normalize_prefix("ge").unwrap() == "GE");
        assert!(normalize_prefix("TOOLONG").is_err());
        assert!(normalize_prefix("a/b").is_err());
    }

    #[test]
    fn grids_by_height() {
        assert_eq!(grid_for(Some(2)), Grid { rows: 2, cols: 48 });
        assert_eq!(grid_for(Some(1)), Grid { rows: 1, cols: 48 });
        assert_eq!(grid_for(Some(0)), Grid { rows: 120, cols: 4 });
        assert_eq!(grid_for(None).rows, 8);
    }

    #[test]
    fn diff_matches_by_code() {
        let g = generate(
            &[group(Face::Front, 0, 0, 1, 3, "")],
            &[],
            grid_for(Some(2)),
        )
        .unwrap();
        let existing = vec![
            (10, "1".to_string()),
            (11, "2".to_string()),
            (12, "9".to_string()),
        ];
        let d = diff(&existing, &g);
        assert_eq!(d.kept, vec![(10, "1".into()), (11, "2".into())]);
        assert_eq!(d.removed, vec![(12, "9".into())]);
        assert_eq!(d.added, vec!["3".to_string()]);
    }
}
