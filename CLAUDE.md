# CLAUDE.md

## Development Rules

### Database Changes — MANDATORY
Any time a new table, column, index, or constraint is added to the codebase, a migration file MUST be created in the same commit. No exceptions.

- Migration files live in api/src/db/migrations/
- Files are numbered sequentially: 001_, 002_, 003_ etc.
- Use ALTER TABLE ... ADD COLUMN IF NOT EXISTS for columns
- Use CREATE TABLE IF NOT EXISTS for new tables
- Never modify existing migration files — always create a new one
- Test that the migration runs cleanly on an existing database before pushing

Failure to include a migration file means existing deployments will get 500 errors after updating.
