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
