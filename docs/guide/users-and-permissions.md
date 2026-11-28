# Users and permissions

Open **Users and access** in the sidebar (account administrators only).

## Roles

| Role | Can |
|---|---|
| **Reader** | See everything in the project |
| **Editor** | Also add, change and delete documentation; document or ignore discovered hosts |
| **Admin** | Also manage integrations, network discovery and SNMP devices, and give other people access within their scope |

A role is given at a **scope**:

- **Account**: every project, including future ones;
- **Project**: one project;
- **Location, room, rack or device**: edit rights cover only that part (and
  everything inside it). Reading is always project-wide, so an editor of one
  rack can still look up the rest of the project.

Admins can only give access within what they administer. Things someone
can't see answer "not found", so their existence isn't revealed.

## Adding people

### Directly

1. **Users and access** → **Add user**: a username (and optionally a name and
   email).
2. Rackpath shows a **temporary password**. Pass it on safely; they choose
   their own at first sign-in.
3. Open the user → **Give access** → role and scope.

### By invitation

1. **Invitations** → create one with the access it gives, optionally for a
   named email.
2. Rackpath shows a **link, once**. Send it however you like; Rackpath sends
   no email itself.
3. The link works once, for 7 days. The person picks a username and password.

## Managing users

On a user's page you can disable or delete them, reset their password,
**turn off 2FA** (if they lost their phone and recovery codes), and change
their access. Changing a password signs out their other sessions.

The **owner** (the first `admin` user) can't be disabled, deleted or reset by
anyone else. Ownership can be transferred.

## Sign-in security

- Passwords are at least 10 characters, stored with argon2id.
- Repeated failed sign-ins are rate limited per username and per address.
- Sessions end after 12 hours idle or 7 days.
- Require **two-factor sign-in** for everyone: **Users and access** →
  **Account settings**.

## The Activity log

**Activity** lists every change: who, when, and the values before and after.
Filter by project, action, kind of thing and date. Integration syncs,
discovery scans and SNMP polls appear as `sync` entries. The log can't be
edited; set `RACKPATH_AUDIT_RETENTION_DAYS` to delete old entries
automatically.
