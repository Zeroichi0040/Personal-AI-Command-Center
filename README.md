# Personal AI Command Center (PACC)

A local-first command center for managing Codex conversations, projects and development tasks. Use your existing Codex sign-in, run up to two independent generations, and keep control of approvals and review.

**Status:** v0.1.0 release candidate. Windows live workflows have been verified by the maintainer; Windows and Linux have automated CI coverage. Not a hosted service or remote-access gateway.

## What it does

- Register local repositories and switch between independent Codex sessions without stopping ongoing work.
- Choose read-only, existing writable or isolated Git worktree workspaces. PACC does not automatically push, merge or delete worktrees.
- Stream messages and tool activity; queue, steer, interrupt and explicitly approve supported operations.
- Restore local SQLite history and reconnect to native Codex threads after restarting.
- Search across saved conversations, export Markdown/JSON and create local database backups.
- Manage a persistent backlog with priorities, acceptance criteria, manual session assignment and dispatch. Model completion moves tasks to Review, not Done.

## Requirements

Node.js 22.13 or newer, npm, Git, and the Codex CLI installed and signed in with ChatGPT using `codex login`. Windows and Linux are the supported target platforms. Use trusted repositories only.

```powershell
git clone https://github.com/Zeroichi0040/Personal-AI-Command-Center.git
cd Personal-AI-Command-Center
npm install
codex login status
npm run dev
```

Open **http://127.0.0.1:4317**. Stop the backend with Ctrl+C. Closing the browser leaves the backend running. After restarting, reconnect saved sessions explicitly.

If Codex cannot be found on Windows, set `$env:CODEX_EXECUTABLE = 'C:\path\to\codex.exe'` to the actual native executable (not a .cmd shim). See [setup and limitations](docs/client.md).

## Data and safety

- History defaults to `~/.pacc/history.sqlite` (under your user profile on Windows); override with `PACC_DATA_PATH`. It is local plaintext and may contain private code, prompts and command output. Protect backups too.
- New isolated worktrees default to `~/.pacc/worktrees`. Override with an absolute `PACC_WORKTREE_DIR`. Existing worktrees are not moved. Inspect changes before manually deleting any worktree.
- Use the History backup button in session details. Schema migrations create a separate backup of existing databases. To restore, stop PACC, preserve the current database and its WAL/SHM files, and start with `PACC_DATA_PATH` pointing to a **copy** of a chosen backup.
- Saved queues, pending approvals and unfinished tasks are not automatically replayed.
- Loopback Host/origin checks and a random per-process token protect browser controls. This is not a security boundary against other local processes running as your user. Do not expose the port over a network. Codex enforces its own sandbox; elevated operations can escape it. Review each approval; use trusted repositories and local Git configuration.
- Native Codex history remains authoritative for model context. PACC's display mirror may be incomplete after a crash; inspect native history/workspace before retrying an uncertain operation.

## Verification

```sh
npm run typecheck
npm run build
npm test
npm run smoke
```

Offline tests do not consume model usage. The smoke handshake checks the installed runtime and ChatGPT account; `npm run smoke -- --live` explicitly submits two turns and verifies native recall after reconnect. It consumes normal Codex usage.

See [roadmap](docs/roadmap.md) and [client documentation](docs/client.md). Automatic orchestration, remote access, shared agent memory and other providers are deferred.
