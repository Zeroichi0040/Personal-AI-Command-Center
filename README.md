# Personal AI Command Center

A local-first, personal AI development environment. The first release targets Codex; other runtimes are planned later.

## Status: Milestone 1 — runtime validation (pre-release)

This is a dependency-free protocol spike, not yet the web application. It validates the App Server handshake, existing ChatGPT account detection, and an opt-in two-turn native thread resume workflow. JavaScript ES modules keep the initial compatibility test independent of build tools; the typed application adapter and UI follow once the real runtime is verified.

## Requirements

- Node.js 22 or newer
- Codex CLI installed locally and signed in using ChatGPT (`codex login`)
- Windows or Linux (Windows CI configured but not yet run)

Run from this directory:

```sh
npm test
npm run smoke
```

The default smoke test starts the installed Codex App Server and checks the handshake and authentication mode. It does not submit a model turn. The live test deliberately submits two turns, consumes normal Codex usage, and creates a persistent native Codex thread:

```sh
npm run smoke -- --live
```

It runs in a temporary directory, requests read-only execution with no approvals, and attempts to recall a codeword after restarting App Server. The temporary directory is removed afterward; the native Codex conversation remains in Codex history. No secrets or account email are printed. The test is specifically for ChatGPT-managed authentication and refuses API-key mode. Do not use this as a commercial or hosted service integration.

If the executable is not found, supply a trusted absolute path to the native Codex executable. Windows npm command shims (`.cmd`) are not directly executable through this shell-free transport. In PowerShell:

```powershell
$env:CODEX_EXECUTABLE = 'C:\path\to\codex.exe'
npm run smoke
npm run smoke -- --live
```

On Linux, set `CODEX_EXECUTABLE` to the absolute executable path if necessary.

## Testing

The mock server runs offline and consumes no model credits. It exercises handshake, errors, unsupported server requests, out-of-order events, timeouts and disconnects. Mock recall is a fixture, not proof of actual model memory. GitHub Actions is configured for Windows and Linux. Live authentication and recall must be verified locally before proceeding to the application UI.

See [roadmap](docs/roadmap.md) and the [official App Server protocol](https://learn.chatgpt.com/docs/app-server).
