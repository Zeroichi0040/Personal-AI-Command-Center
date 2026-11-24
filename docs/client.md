# Milestone 2 preview

Run npm install, npm run typecheck, npm test, then npm run dev. Open http://127.0.0.1:4317 (not localhost). Stop the backend with Ctrl+C. The frontend is built and served from the same origin, with no CORS or separate public Vite server. No model calls until you send a message.

The current directory is the default workspace, and the default sandbox is read-only. Set PACC_WORKSPACE to a trusted repository path before starting; set PACC_WORKSPACE_WRITE=1 only if you intend to allow writes in that workspace. Codex enforces sandboxing; approvals may elevate individual operations, so inspect each request. Unsupported requests, actual additional permission grants, and network approvals are rejected with visible diagnostics. Optional command policy suggestions do not block one-time approval; PACC never accepts policy amendments or session-wide grants. Command previews may use the matching started item when the runtime omits the command in an approval request. Stream-only snapshots are coalesced over 50 ms; approvals, turn changes and completion are immediate. Never expose this service to the internet or share the browser token. Existing Codex login is required.

PowerShell example:

    $env:PACC_WORKSPACE = 'C:\path\to\repo'
    $env:PACC_WORKSPACE_WRITE = '1'
    npm run dev

This preview uses one in-memory conversation per server process. Closing/reopening the browser reconnects to the same view while the server lives. Restarting the server does not restore the client view yet; Codex retains its own native history. No project manager, worktrees, usage counters, persistent application history, or multi-agent support yet. Model picker is runtime-driven. Reasoning displays only exposed summaries, not raw reasoning. Working timer is elapsed wall time, not a measure of model compute.

Test manually against Codex 0.171.0: send a harmless prompt, inspect streamed Markdown, ask a read-only command, queue a follow-up, steer an active turn, stop a turn, refresh the browser while running, and test approval/decline using a harmless command in a disposable workspace. Do not enable unrestricted sandbox. CI uses mock tests; live runtime behavior still requires local confirmation.

The backend retains the validated JavaScript transport during this preview; the frontend is TypeScript. Typed protocol generation and stronger browser integration coverage are follow-up work. Dependencies are installed via npm install; generate and commit a package-lock after the first verified install.

## Milestone 3 preview

Register an absolute local Git repository path in the sidebar. Each session has a separate authenticated Codex App Server and native thread. The project list and client history live in memory until Milestone 4. The initial workspace is registered automatically (a non-Git directory is allowed only for the startup workspace). Up to 12 sessions and 20 projects can exist, with two simultaneous active generations. Sending to a third idle session is rejected; existing active-session follow-ups still queue. Uncertain runtime outcomes reserve a slot until restart. Session switching does not interrupt work.

Read-only is the default. Existing writable mode reserves its canonical workspace against overlapping writable sessions for the session lifetime. Isolated mode creates a new pacc/<session-id> branch from HEAD in a temporary-directory worktree, without copying uncommitted edits. Inspect Git status/diff summary explicitly in session details. Closing/removing sessions or restarting never deletes worktrees, branches or files. Record the worktree path before closing; remove it manually only after checking changes. Git is invoked without a shell and no push, merge, reset or force is performed by the manager. Git repositories and their configuration must be trusted. Sandbox approvals may escape workspace boundaries; PACC blocks approval if another writable reservation overlaps the current workspace, but cannot sandbox elevated commands itself. Read-only sessions may observe changes made by other sessions. 
