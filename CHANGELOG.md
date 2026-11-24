# Changelog

## v0.1.0-rc.1

Initial release candidate.

- Local authenticated Codex App Server integration, streaming, approvals, queue, steer and stop.
- Project registration, independent sessions, two-generation limit, isolated Git worktrees.
- SQLite conversation history, native thread reconnect, search and export.
- Manual task board, explicit dispatch, attempts, review and interruption recovery.
- Versioned database migration, local backups, incremental search index updates, workspace checks, durable worktree location, and lifecycle hardening.

Known limitations: local-only; no automatic orchestration or remote access; native history may contain events absent from the local mirror after a crash; dependency lockfile still requires a verified maintainer install before final release.
