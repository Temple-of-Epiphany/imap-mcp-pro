# Contributing to IMAP MCP Pro

Thanks for your interest in contributing. This document covers how to file issues, propose changes, and get a PR merged.

## Before you start

1. **Read the [README](./README.md)** for an overview of what the project does and which features are already shipped.
2. **Check [open issues](https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues)** before opening a new one — your idea or bug may already be tracked.
3. **For security issues**, see [`SECURITY.md`](./SECURITY.md). **Do not** open a public issue for vulnerabilities.
4. **Read [`CLAUDE.md`](./CLAUDE.md)** if you're going to use Claude Code or other AI assistants on this codebase. It documents project-specific conventions.

## Filing an issue

Use the issue templates:

- **Bug report** — something doesn't work the way it should
- **Feature request** — propose a new capability or workflow

Good bug reports include:

- Version (`imap_about` tool output, or `package.json` version)
- Account provider (Gmail / Outlook / Hostinger / etc.)
- Steps to reproduce
- Expected vs. actual behavior
- Logs (sanitize credentials!)

## Proposing a change

1. **Open an issue first** for anything beyond a typo fix or trivial cleanup. We want to align on direction before you spend time coding.
2. **Fork the repo and create a feature branch** off `main`.
3. **Make your change.** Conventions:
   - 2-space indentation (matches existing code)
   - TypeScript strict mode is on; new code must compile clean
   - Follow the existing module patterns — look at neighboring services in `src/services/` before inventing new structures
   - Author block at the top of new files: name, email, dates, version
4. **Test locally**:
   - `npm run build` must pass
   - If you touched the cache or skill installer, run the smoke tests:
     - `npx tsx scripts/smoke-test-cache.ts <accountId> [folder]`
     - `npx tsx scripts/smoke-test-skills-install.ts`
   - For tool changes, verify `node dist/index.js --print-tools-manifest` runs and includes your new tool
5. **Update docs**: README for user-visible features, CHANGELOG for any user-visible change, MIGRATION.md if you change configuration or schema.
6. **Open a PR** targeting `main`. Reference the issue you opened in step 1. Fill out the PR template.

## What we're picky about

- **Schema migrations** must be reversible. Every `schema_update_X.Y.Z_TO_A.B.C.sql` ships with a matching `.down.sql` and an entry in `migrations-manifest.json`.
- **Tool annotations** — every new tool must have an entry in `src/tools/annotations.ts` (drives Claude Desktop's permissions UI).
- **No breaking changes without a major version bump.** Tool surfaces, env vars, and config keys are public API.
- **No telemetry** — we don't add outbound HTTP calls the user didn't explicitly invoke.
- **No swallowed errors** — surface failures clearly. Best-effort callers wrap in `try/catch` and log; don't silently no-op.
- **No `--no-verify` on commits**, no `--force-push` on shared branches.

## What we're flexible about

- Style nits — there's no enforced linter beyond `tsc`. If `tsc` is happy, we'll discuss style during review rather than block.
- Test coverage — there's no test framework yet (planned for v3.x). For now, feature work ships with a smoke test under `scripts/` showing it works end-to-end against a real account.
- AI-assistance — this codebase has been shipped with Claude Code's help; AI co-authorship is welcome and noted via the `Co-Authored-By` trailer in commit messages.

## Project structure

```
src/
  services/       # Long-lived stateful objects (DatabaseService, ImapService, etc.)
  tools/          # MCP tool registrations, grouped by domain
  database/       # Schema + migrations
  config/         # ServerConfig schema + multi-source loader
  startup.ts      # Three-stage startup (pre-handshake / handshake / post-handshake)
skills/           # Skills bundled into the .mcpb (auto-installed on startup)
scripts/          # Smoke tests, build helpers, install/backup/restore
dxt/              # .mcpb build pipeline + manifest template
docs/             # Architecture notes, audit reports
rfc/              # IMAP4rev2 RFC for reference
```

## Releases

- Maintainers tag `vX.Y.Z` on `main` to trigger the build-dxt.yml workflow.
- The workflow produces `.mcpb` artifacts for `macos-arm64`, `windows-x64`, `linux-x64` and attaches them to the GitHub Release.
- Release notes are auto-built from `CHANGELOG.md`.

## License

By contributing, you agree your contributions are licensed under the same dual-license model documented in [`LICENSE`](./LICENSE) (non-commercial free + commercial paid).

## Questions

Email **colin.bitterfield@templeofepiphany.com** or open a discussion via a GitHub issue (with the `question` label).
