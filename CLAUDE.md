# CLAUDE.md

## Development Rules

### Database Changes — MANDATORY
Any time a new table, column, index, or constraint is added to the codebase, a migration file MUST be created in the same commit. No exceptions.

- Migration files live in api-rs/migrations/ (SQLite).
- Files are numbered sequentially with four digits: 0001_, 0002_, 0003_ etc. (continue from the highest existing number)
- Use ALTER TABLE ... ADD COLUMN IF NOT EXISTS for columns
- Use CREATE TABLE IF NOT EXISTS for new tables
- Never modify existing migration files — always create a new one
- Test that the migration runs cleanly on an existing database before pushing

Failure to include a migration file means existing deployments will get 500 errors after updating.

### Rust API (api-rs/) — before pushing
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` and `cargo audit` must all pass.
- Permission rules live in `src/domain/permissions.rs` as pure functions; any change to them needs unit tests there.
- SQL must be literal strings with bound parameters (sqlx enforces this); build dynamic filters with `QueryBuilder`.
- Every data change writes its audit entry in the same transaction (`audit::record`).
