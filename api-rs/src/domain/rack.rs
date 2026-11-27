//! Rack geometry (design section 5): positions in half-rack-unit steps and
//! the rules for what can share a rack unit.
//!
//! * A device occupies `[pos, pos + height)` in half-U steps, on a face
//!   (front, rear, or both for full-depth gear) and a width (full, left half,
//!   right half).
//! * Two devices clash when their ranges overlap, their faces clash (either
//!   is full depth, or both use the same face) and their widths clash (full
//!   width, or the same half).
//! * Zero-U devices (vertical PDUs) sit in the side channels and use no slots.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Face {
    Front,
    Rear,
    Both,
}

impl Face {
    pub fn as_str(self) -> &'static str {
        match self {
            Face::Front => "front",
            Face::Rear => "rear",
            Face::Both => "both",
        }
    }
    pub fn parse(s: &str) -> Option<Face> {
        match s {
            "front" => Some(Face::Front),
            "rear" => Some(Face::Rear),
            "both" => Some(Face::Both),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mount {
    FullWidth,
    HalfLeft,
    HalfRight,
    ZeroULeft,
    ZeroURight,
}

impl Mount {
    pub fn as_str(self) -> &'static str {
        match self {
            Mount::FullWidth => "full_width",
            Mount::HalfLeft => "half_left",
            Mount::HalfRight => "half_right",
            Mount::ZeroULeft => "zero_u_left",
            Mount::ZeroURight => "zero_u_right",
        }
    }
    pub fn parse(s: &str) -> Option<Mount> {
        match s {
            "full_width" => Some(Mount::FullWidth),
            "half_left" => Some(Mount::HalfLeft),
            "half_right" => Some(Mount::HalfRight),
            "zero_u_left" => Some(Mount::ZeroULeft),
            "zero_u_right" => Some(Mount::ZeroURight),
            _ => None,
        }
    }
    pub fn is_zero_u(self) -> bool {
        matches!(self, Mount::ZeroULeft | Mount::ZeroURight)
    }
}

/// One device's footprint in a rack.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slot {
    pub device_id: i64,
    /// Lowest occupied half-U (0 = bottom of U1). None only for zero-U.
    pub pos_half: Option<i64>,
    pub height_half: i64,
    pub face: Face,
    pub mount: Mount,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum FitError {
    #[error("A rack position is required")]
    MissingPosition,
    #[error("The device doesn't fit inside the rack at that position")]
    OutsideRack,
    #[error("That space is already taken")]
    Overlap { device_id: i64 },
}

/// `U` as the user sees it (1, 1.5, 2, …) → half-U position (0, 1, 2, …).
pub fn u_to_pos_half(u: f64) -> Result<i64, &'static str> {
    if !u.is_finite() || u < 1.0 {
        return Err("Rack position must be U1 or higher");
    }
    let doubled = u * 2.0;
    if (doubled - doubled.round()).abs() > 1e-9 {
        return Err("Rack position must be a whole or half U");
    }
    Ok(doubled.round() as i64 - 2)
}

pub fn pos_half_to_u(pos: i64) -> f64 {
    (pos + 2) as f64 / 2.0
}

/// Height in U (0.5, 1, 2, …) → half-U steps.
pub fn height_to_half(height: f64) -> Result<i64, &'static str> {
    if !height.is_finite() || !(0.5..=60.0).contains(&height) {
        return Err("Height must be between 0.5U and 60U");
    }
    let doubled = height * 2.0;
    if (doubled - doubled.round()).abs() > 1e-9 {
        return Err("Height must be a whole or half U");
    }
    Ok(doubled.round() as i64)
}

fn faces_clash(a: Face, b: Face) -> bool {
    a == Face::Both || b == Face::Both || a == b
}

fn widths_clash(a: Mount, b: Mount) -> bool {
    matches!(
        (a, b),
        (Mount::FullWidth, _)
            | (_, Mount::FullWidth)
            | (Mount::HalfLeft, Mount::HalfLeft)
            | (Mount::HalfRight, Mount::HalfRight)
    )
}

/// Checks whether `new` fits in a rack of `rack_u` units next to `others`
/// (which must not include `new` itself).
pub fn check_fit(new: &Slot, others: &[Slot], rack_u: i64) -> Result<(), FitError> {
    if new.mount.is_zero_u() {
        return Ok(());
    }
    let pos = new.pos_half.ok_or(FitError::MissingPosition)?;
    if pos < 0 || pos + new.height_half > rack_u * 2 {
        return Err(FitError::OutsideRack);
    }
    for other in others {
        if other.device_id == new.device_id || other.mount.is_zero_u() {
            continue;
        }
        let Some(other_pos) = other.pos_half else {
            continue;
        };
        let overlap = pos < other_pos + other.height_half && other_pos < pos + new.height_half;
        if overlap && faces_clash(new.face, other.face) && widths_clash(new.mount, other.mount) {
            return Err(FitError::Overlap {
                device_id: other.device_id,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(id: i64, u: f64, height: f64, face: Face, mount: Mount) -> Slot {
        Slot {
            device_id: id,
            pos_half: Some(u_to_pos_half(u).unwrap()),
            height_half: height_to_half(height).unwrap(),
            face,
            mount,
        }
    }

    #[test]
    fn u_conversions() {
        assert_eq!(u_to_pos_half(1.0), Ok(0));
        assert_eq!(u_to_pos_half(1.5), Ok(1));
        assert_eq!(u_to_pos_half(42.0), Ok(82));
        assert!(u_to_pos_half(0.5).is_err());
        assert!(u_to_pos_half(1.25).is_err());
        assert!(u_to_pos_half(f64::NAN).is_err());
        assert_eq!(pos_half_to_u(1), 1.5);
        assert_eq!(height_to_half(2.0), Ok(4));
        assert_eq!(height_to_half(0.5), Ok(1));
        assert!(height_to_half(0.0).is_err());
        assert!(height_to_half(1.3).is_err());
    }

    #[test]
    fn must_fit_inside_the_rack() {
        let top = slot(1, 42.0, 1.0, Face::Front, Mount::FullWidth);
        assert_eq!(check_fit(&top, &[], 42), Ok(()));
        let too_tall = slot(1, 41.0, 4.0, Face::Front, Mount::FullWidth);
        assert_eq!(check_fit(&too_tall, &[], 42), Err(FitError::OutsideRack));
        let no_pos = Slot {
            pos_half: None,
            ..top
        };
        assert_eq!(check_fit(&no_pos, &[], 42), Err(FitError::MissingPosition));
    }

    #[test]
    fn same_face_overlap_clashes() {
        let existing = [slot(1, 10.0, 2.0, Face::Front, Mount::FullWidth)];
        assert_eq!(
            check_fit(
                &slot(2, 11.0, 1.0, Face::Front, Mount::FullWidth),
                &existing,
                42
            ),
            Err(FitError::Overlap { device_id: 1 })
        );
        assert_eq!(
            check_fit(
                &slot(2, 12.0, 1.0, Face::Front, Mount::FullWidth),
                &existing,
                42
            ),
            Ok(()),
            "directly above"
        );
        assert_eq!(
            check_fit(
                &slot(2, 9.0, 1.0, Face::Front, Mount::FullWidth),
                &existing,
                42
            ),
            Ok(()),
            "directly below"
        );
    }

    #[test]
    fn front_and_rear_can_share_a_unit_unless_full_depth() {
        let front = [slot(1, 5.0, 1.0, Face::Front, Mount::FullWidth)];
        assert_eq!(
            check_fit(&slot(2, 5.0, 1.0, Face::Rear, Mount::FullWidth), &front, 42),
            Ok(())
        );
        assert!(check_fit(&slot(2, 5.0, 1.0, Face::Both, Mount::FullWidth), &front, 42).is_err());
        let deep = [slot(1, 5.0, 2.0, Face::Both, Mount::FullWidth)];
        assert!(check_fit(&slot(2, 6.0, 1.0, Face::Rear, Mount::FullWidth), &deep, 42).is_err());
    }

    #[test]
    fn half_width_devices_pair_side_by_side() {
        let left = [slot(1, 3.0, 1.0, Face::Front, Mount::HalfLeft)];
        assert_eq!(
            check_fit(&slot(2, 3.0, 1.0, Face::Front, Mount::HalfRight), &left, 42),
            Ok(())
        );
        assert!(check_fit(&slot(2, 3.0, 1.0, Face::Front, Mount::HalfLeft), &left, 42).is_err());
        assert!(check_fit(&slot(2, 3.0, 1.0, Face::Front, Mount::FullWidth), &left, 42).is_err());
    }

    #[test]
    fn half_u_positions() {
        let lower = [slot(1, 1.0, 0.5, Face::Front, Mount::FullWidth)];
        assert_eq!(
            check_fit(
                &slot(2, 1.5, 0.5, Face::Front, Mount::FullWidth),
                &lower,
                42
            ),
            Ok(())
        );
        assert!(check_fit(
            &slot(2, 1.0, 1.0, Face::Front, Mount::FullWidth),
            &lower,
            42
        )
        .is_err());
    }

    #[test]
    fn zero_u_devices_use_no_slots() {
        let pdu = Slot {
            device_id: 9,
            pos_half: None,
            height_half: 2,
            face: Face::Rear,
            mount: Mount::ZeroULeft,
        };
        assert_eq!(
            check_fit(
                &pdu,
                &[slot(1, 1.0, 42.0, Face::Both, Mount::FullWidth)],
                42
            ),
            Ok(())
        );
        let server = slot(2, 1.0, 2.0, Face::Both, Mount::FullWidth);
        assert_eq!(check_fit(&server, &[pdu], 42), Ok(()));
    }

    #[test]
    fn a_device_does_not_clash_with_itself() {
        let me = slot(1, 4.0, 2.0, Face::Front, Mount::FullWidth);
        assert_eq!(check_fit(&me, &[me], 42), Ok(()));
    }
}
