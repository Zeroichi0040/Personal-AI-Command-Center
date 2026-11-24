# v0.1.0 roadmap

1. Runtime validation: JSONL RPC, authentication preflight, opt-in streaming and resume smoke test; generate protocol definitions from the target installed version; verify Windows and Linux behavior. Go/no-go: actual ChatGPT-managed Codex successfully completes both turns and recalls the codeword after reconnect.
2. Core client: TypeScript provider adapter, React/Vite and Fastify, local authenticated transport, conversation streaming, model controls, approvals, interrupt and steer; fail closed on unsupported requests.
3. Projects and sessions: project registration, at most two simultaneous generations by default, worktree isolation, read-only review mode, no automatic push/merge, no destructive cleanup.
4. Persistence: SQLite and FTS5, native thread as source of truth, idempotent history reconciliation, export and deletion, sensitive data minimization.
5. Tasks: manual backlog and assignment; project, priority, acceptance criteria, status and session association. No unsolicited model calls.
6. Release hardening: cross-platform tests, recovery and concurrency tests, security checks, documentation and packaging.

Deferred: automatic orchestration, shared agent memory, remote access, voice, other providers. Use local-only networking, origin validation, authenticated control requests, Codex sandbox enforcement and explicit approvals before exposing any browser interface. Keep account credentials managed by Codex. No automatic retries of generation requests with uncertain outcomes.
