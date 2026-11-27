//! The permission engine (design section 10). Pure functions over a user's
//! grants and the "chain" of scopes a resource sits in, from the account
//! down to the resource itself. No I/O, so every rule is unit-tested below.
//!
//! Rules:
//! * The owner can do everything.
//! * **Read** is project-wide: any grant inside a project lets the user read
//!   the whole project. Account-wide grants read everything.
//! * **Write** needs an editor or admin grant on the resource or one of its
//!   ancestors (grants cascade downward).
//! * **Manage** (users, grants, integrations, settings) needs an admin grant
//!   on the resource or an ancestor.
//! * A connection can be edited if either end's device can be edited.
//! * The widest grant wins; adding a grant never narrows access.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Reader,
    Editor,
    Admin,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Reader => "reader",
            Role::Editor => "editor",
            Role::Admin => "admin",
        }
    }
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "reader" => Some(Role::Reader),
            "editor" => Some(Role::Editor),
            "admin" => Some(Role::Admin),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScopeType {
    Account,
    Project,
    Location,
    Floor,
    Room,
    Rack,
    Device,
}

impl ScopeType {
    pub fn as_str(self) -> &'static str {
        match self {
            ScopeType::Account => "account",
            ScopeType::Project => "project",
            ScopeType::Location => "location",
            ScopeType::Floor => "floor",
            ScopeType::Room => "room",
            ScopeType::Rack => "rack",
            ScopeType::Device => "device",
        }
    }
    pub fn parse(s: &str) -> Option<ScopeType> {
        Some(match s {
            "account" => ScopeType::Account,
            "project" => ScopeType::Project,
            "location" => ScopeType::Location,
            "floor" => ScopeType::Floor,
            "room" => ScopeType::Room,
            "rack" => ScopeType::Rack,
            "device" => ScopeType::Device,
            _ => return None,
        })
    }
}

/// One level of the hierarchy. `id` is None only for the account.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Scope {
    pub kind: ScopeType,
    pub id: Option<i64>,
}

impl Scope {
    pub const ACCOUNT: Scope = Scope {
        kind: ScopeType::Account,
        id: None,
    };
    pub fn new(kind: ScopeType, id: i64) -> Scope {
        debug_assert!(kind != ScopeType::Account);
        Scope { kind, id: Some(id) }
    }
    pub fn project(id: i64) -> Scope {
        Scope::new(ScopeType::Project, id)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grant {
    pub role: Role,
    pub scope: Scope,
    /// The project the scope belongs to; None for account-wide grants.
    pub project_id: Option<i64>,
}

/// The scopes a resource sits in, from the account down to the resource.
/// Always starts with the account; the second entry, when present, is the
/// resource's project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chain(Vec<Scope>);

impl Chain {
    pub fn account() -> Chain {
        Chain(vec![Scope::ACCOUNT])
    }
    pub fn project(project_id: i64) -> Chain {
        Chain(vec![Scope::ACCOUNT, Scope::project(project_id)])
    }
    /// Extends a chain one level down (e.g. project → location).
    pub fn child(&self, kind: ScopeType, id: i64) -> Chain {
        let mut scopes = self.0.clone();
        scopes.push(Scope::new(kind, id));
        Chain(scopes)
    }
    pub fn project_id(&self) -> Option<i64> {
        self.0
            .get(1)
            .filter(|s| s.kind == ScopeType::Project)
            .and_then(|s| s.id)
    }
    pub fn target(&self) -> Scope {
        *self.0.last().expect("chain is never empty")
    }
    fn contains(&self, scope: &Scope) -> bool {
        self.0.contains(scope)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Read,
    Write,
    Manage,
}

/// Which projects a user may see in listings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectFilter {
    All,
    Only(Vec<i64>),
}

impl ProjectFilter {
    pub fn allows(&self, project_id: i64) -> bool {
        match self {
            ProjectFilter::All => true,
            ProjectFilter::Only(ids) => ids.contains(&project_id),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Principal {
    pub is_owner: bool,
    pub grants: Vec<Grant>,
}

impl Principal {
    pub fn can(&self, action: Action, chain: &Chain) -> bool {
        if self.is_owner {
            return true;
        }
        match action {
            Action::Read => self.grants.iter().any(|g| {
                g.scope.kind == ScopeType::Account
                    || (chain.project_id().is_some() && g.project_id == chain.project_id())
            }),
            Action::Write => self
                .grants
                .iter()
                .any(|g| g.role >= Role::Editor && chain.contains(&g.scope)),
            Action::Manage => self
                .grants
                .iter()
                .any(|g| g.role == Role::Admin && chain.contains(&g.scope)),
        }
    }

    /// A cable can be edited by anyone who can edit either end.
    pub fn can_edit_connection(&self, end_a: &Chain, end_b: &Chain) -> bool {
        self.can(Action::Write, end_a) || self.can(Action::Write, end_b)
    }

    /// Whether this user may give (or take away) `role` at the scope `chain`
    /// points to. Needs admin rights covering that scope; readers can only be
    /// granted at account or project level.
    pub fn can_grant(&self, role: Role, chain: &Chain) -> bool {
        let target = chain.target();
        if role == Role::Reader && !matches!(target.kind, ScopeType::Account | ScopeType::Project) {
            return false;
        }
        self.can(Action::Manage, chain)
    }

    pub fn is_account_admin(&self) -> bool {
        self.is_owner || self.can(Action::Manage, &Chain::account())
    }

    /// Admins at any scope may list users (to grant them access) and invite.
    pub fn is_any_admin(&self) -> bool {
        self.is_owner || self.grants.iter().any(|g| g.role == Role::Admin)
    }

    pub fn readable_projects(&self) -> ProjectFilter {
        if self.is_owner
            || self
                .grants
                .iter()
                .any(|g| g.scope.kind == ScopeType::Account)
        {
            return ProjectFilter::All;
        }
        let mut ids: Vec<i64> = self.grants.iter().filter_map(|g| g.project_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ProjectFilter::Only(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P1: i64 = 1;
    const P2: i64 = 2;

    fn grant(role: Role, scope: Scope, project_id: Option<i64>) -> Grant {
        Grant {
            role,
            scope,
            project_id,
        }
    }
    fn principal(grants: Vec<Grant>) -> Principal {
        Principal {
            is_owner: false,
            grants,
        }
    }
    /// account → P1 → location 10 → floor 20 → room 30 → rack 40 → device 50
    fn rack_device_chain() -> Chain {
        Chain::project(P1)
            .child(ScopeType::Location, 10)
            .child(ScopeType::Floor, 20)
            .child(ScopeType::Room, 30)
            .child(ScopeType::Rack, 40)
            .child(ScopeType::Device, 50)
    }
    /// A device in a different room of the same project.
    fn other_room_device_chain() -> Chain {
        Chain::project(P1)
            .child(ScopeType::Location, 10)
            .child(ScopeType::Floor, 20)
            .child(ScopeType::Room, 31)
            .child(ScopeType::Device, 60)
    }

    #[test]
    fn owner_can_do_everything() {
        let owner = Principal {
            is_owner: true,
            grants: vec![],
        };
        for action in [Action::Read, Action::Write, Action::Manage] {
            assert!(owner.can(action, &Chain::account()));
            assert!(owner.can(action, &rack_device_chain()));
        }
        assert!(owner.is_account_admin());
        assert_eq!(owner.readable_projects(), ProjectFilter::All);
    }

    #[test]
    fn no_grants_means_no_access() {
        let p = principal(vec![]);
        for action in [Action::Read, Action::Write, Action::Manage] {
            assert!(!p.can(action, &Chain::project(P1)));
            assert!(!p.can(action, &rack_device_chain()));
        }
        assert_eq!(p.readable_projects(), ProjectFilter::Only(vec![]));
        assert!(!p.is_any_admin());
    }

    #[test]
    fn account_reader_reads_everything_writes_nothing() {
        let p = principal(vec![grant(Role::Reader, Scope::ACCOUNT, None)]);
        assert!(p.can(Action::Read, &Chain::project(P1)));
        assert!(p.can(Action::Read, &Chain::project(P2)));
        assert!(p.can(Action::Read, &rack_device_chain()));
        assert!(!p.can(Action::Write, &rack_device_chain()));
        assert!(!p.can(Action::Manage, &Chain::project(P1)));
        assert_eq!(p.readable_projects(), ProjectFilter::All);
    }

    #[test]
    fn project_reader_reads_only_that_project() {
        let p = principal(vec![grant(Role::Reader, Scope::project(P1), Some(P1))]);
        assert!(p.can(Action::Read, &rack_device_chain()));
        assert!(!p.can(Action::Read, &Chain::project(P2)));
        assert!(!p.can(Action::Write, &Chain::project(P1)));
        assert_eq!(p.readable_projects(), ProjectFilter::Only(vec![P1]));
    }

    #[test]
    fn project_editor_writes_everything_in_project_only() {
        let p = principal(vec![grant(Role::Editor, Scope::project(P1), Some(P1))]);
        assert!(p.can(Action::Write, &Chain::project(P1)));
        assert!(p.can(Action::Write, &rack_device_chain()));
        assert!(!p.can(Action::Write, &Chain::project(P2)));
        assert!(!p.can(Action::Read, &Chain::project(P2)));
        assert!(!p.can(Action::Manage, &Chain::project(P1)));
    }

    #[test]
    fn narrow_editor_writes_below_scope_but_reads_whole_project() {
        // Editor on room 30 only.
        let p = principal(vec![grant(
            Role::Editor,
            Scope::new(ScopeType::Room, 30),
            Some(P1),
        )]);
        assert!(
            p.can(Action::Write, &rack_device_chain()),
            "rack device inside the room"
        );
        assert!(
            !p.can(Action::Write, &other_room_device_chain()),
            "device in another room"
        );
        assert!(
            !p.can(Action::Write, &Chain::project(P1)),
            "the project itself"
        );
        assert!(
            p.can(Action::Read, &other_room_device_chain()),
            "read is project-wide"
        );
        assert!(!p.can(Action::Read, &Chain::project(P2)));
        assert_eq!(p.readable_projects(), ProjectFilter::Only(vec![P1]));
    }

    #[test]
    fn device_level_editor_covers_only_that_device() {
        let p = principal(vec![grant(
            Role::Editor,
            Scope::new(ScopeType::Device, 50),
            Some(P1),
        )]);
        assert!(p.can(Action::Write, &rack_device_chain()));
        assert!(!p.can(
            Action::Write,
            &Chain::project(P1)
                .child(ScopeType::Location, 10)
                .child(ScopeType::Floor, 20)
                .child(ScopeType::Room, 30)
                .child(ScopeType::Rack, 40)
        ));
        assert!(!p.can(Action::Write, &other_room_device_chain()));
    }

    #[test]
    fn rack_editor_covers_devices_in_rack_and_on_its_trays() {
        let p = principal(vec![grant(
            Role::Editor,
            Scope::new(ScopeType::Rack, 40),
            Some(P1),
        )]);
        assert!(p.can(Action::Write, &rack_device_chain()));
        // A device sitting on a tray (device 50) in the rack.
        let tray_device = rack_device_chain().child(ScopeType::Device, 51);
        assert!(p.can(Action::Write, &tray_device));
    }

    #[test]
    fn ids_must_match_not_just_kinds() {
        let p = principal(vec![grant(
            Role::Editor,
            Scope::new(ScopeType::Room, 999),
            Some(P1),
        )]);
        assert!(!p.can(Action::Write, &rack_device_chain()));
    }

    #[test]
    fn admin_manages_within_scope_only() {
        let p = principal(vec![grant(
            Role::Admin,
            Scope::new(ScopeType::Location, 10),
            Some(P1),
        )]);
        assert!(p.can(Action::Manage, &rack_device_chain()));
        assert!(p.can(Action::Write, &rack_device_chain()));
        assert!(!p.can(Action::Manage, &Chain::project(P1)));
        assert!(!p.is_account_admin());
        assert!(p.is_any_admin());
    }

    #[test]
    fn account_admin_manages_everything() {
        let p = principal(vec![grant(Role::Admin, Scope::ACCOUNT, None)]);
        assert!(p.is_account_admin());
        assert!(p.can(Action::Manage, &rack_device_chain()));
        assert!(p.can(Action::Manage, &Chain::project(P2)));
    }

    #[test]
    fn widest_grant_wins() {
        let p = principal(vec![
            grant(Role::Reader, Scope::project(P1), Some(P1)),
            grant(Role::Editor, Scope::new(ScopeType::Room, 30), Some(P1)),
        ]);
        assert!(p.can(Action::Write, &rack_device_chain()));
        assert!(p.can(Action::Read, &other_room_device_chain()));
        assert!(!p.can(Action::Write, &other_room_device_chain()));
    }

    #[test]
    fn connection_editable_if_either_end_is() {
        let p = principal(vec![grant(
            Role::Editor,
            Scope::new(ScopeType::Device, 50),
            Some(P1),
        )]);
        assert!(p.can_edit_connection(&rack_device_chain(), &other_room_device_chain()));
        assert!(p.can_edit_connection(&other_room_device_chain(), &rack_device_chain()));
        let q = principal(vec![grant(
            Role::Editor,
            Scope::new(ScopeType::Device, 77),
            Some(P1),
        )]);
        assert!(!q.can_edit_connection(&rack_device_chain(), &other_room_device_chain()));
    }

    #[test]
    fn granting_needs_admin_covering_the_scope() {
        let loc_admin = principal(vec![grant(
            Role::Admin,
            Scope::new(ScopeType::Location, 10),
            Some(P1),
        )]);
        let room = Chain::project(P1)
            .child(ScopeType::Location, 10)
            .child(ScopeType::Floor, 20)
            .child(ScopeType::Room, 30);
        assert!(loc_admin.can_grant(Role::Editor, &room));
        assert!(loc_admin.can_grant(Role::Admin, &room));
        assert!(
            !loc_admin.can_grant(Role::Editor, &Chain::project(P1)),
            "above own scope"
        );
        assert!(!loc_admin.can_grant(Role::Admin, &Chain::account()));
        assert!(
            !loc_admin.can_grant(Role::Reader, &room),
            "readers only at project or account"
        );

        let proj_admin = principal(vec![grant(Role::Admin, Scope::project(P1), Some(P1))]);
        assert!(proj_admin.can_grant(Role::Reader, &Chain::project(P1)));
        assert!(!proj_admin.can_grant(Role::Reader, &Chain::project(P2)));
        assert!(!proj_admin.can_grant(Role::Reader, &Chain::account()));

        let editor = principal(vec![grant(Role::Editor, Scope::project(P1), Some(P1))]);
        assert!(
            !editor.can_grant(Role::Editor, &room),
            "editors can't grant"
        );
    }

    #[test]
    fn account_level_targets_need_account_grants() {
        let proj_admin = principal(vec![grant(Role::Admin, Scope::project(P1), Some(P1))]);
        assert!(!proj_admin.can(Action::Read, &Chain::account()));
        assert!(!proj_admin.can(Action::Manage, &Chain::account()));
        let acct_reader = principal(vec![grant(Role::Reader, Scope::ACCOUNT, None)]);
        assert!(acct_reader.can(Action::Read, &Chain::account()));
        assert!(!acct_reader.can(Action::Write, &Chain::account()));
    }
}
