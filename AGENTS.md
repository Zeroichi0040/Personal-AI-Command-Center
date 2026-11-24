# Repository guidance

- Work on the designated feature branch; do not push to main or merge without approval.
- Keep runtime details isolated from the eventual frontend and provider-neutral application layer.
- Keep tests offline by default; live model usage is explicit opt-in. Do not claim mock tests verify live authentication.
- Never persist credentials, automatically approve sensitive operations, bypass usage limits or expose raw runtime RPC to a browser.
- Preserve Git workspaces and never automatically push, merge or remove dirty worktrees.
- Run npm test before proposing changes. Document protocol and platform limitations.
