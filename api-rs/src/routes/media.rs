//! The media catalog (connectors, transceivers, cable types), so the web
//! app's choices come from the same lists the server checks against.

use axum::Json;
use serde_json::{json, Value};

use crate::auth::CurrentUser;
use crate::domain::media::{Connector, Medium, CABLE_TYPES, CONNECTORS, TRANSCEIVERS};

pub async fn catalog(_current: CurrentUser) -> Json<Value> {
    Json(catalog_json())
}

fn catalog_json() -> Value {
    json!({
        "media": Medium::ALL.iter().map(|m| m.as_str()).collect::<Vec<_>>(),
        "connectors": CONNECTORS.iter().map(|(name, c)| json!({
            "name": name,
            "media": c.media().iter().map(|m| m.as_str()).collect::<Vec<_>>(),
            "cage": matches!(c, Connector::Cage(_)),
        })).collect::<Vec<_>>(),
        "transceivers": TRANSCEIVERS.iter().map(|t| json!({
            "name": t.name, "cage": t.cage.name(), "speed": t.speed, "medium": t.medium().as_str(),
        })).collect::<Vec<_>>(),
        "cable_types": CABLE_TYPES.iter().map(|(name, _)| name).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_lists_every_choice_once() {
        let v = catalog_json();
        let cables = v["cable_types"].as_array().unwrap();
        assert!(cables.contains(&json!("Cat6")) && cables.contains(&json!("OS2")));
        let sfp = v["connectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "SFP+")
            .unwrap();
        assert_eq!(sfp["cage"], true);
        let sr = v["transceivers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "10GBASE-SR")
            .unwrap();
        assert_eq!(
            (sr["cage"].as_str(), sr["speed"].as_u64()),
            (Some("SFP+"), Some(10_000))
        );
        let mut names: Vec<&str> = cables.iter().map(|c| c.as_str().unwrap()).collect();
        names.dedup();
        assert_eq!(names.len(), cables.len());
    }
}
