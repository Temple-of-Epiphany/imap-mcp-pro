# Project Instructions — Claude Desktop paste excerpt

> Auto-generated 2026-10-19 by github-operations v3.11.0.
> Paste the section below into Claude Desktop's project "Custom
> instructions" textbox. The full CLAUDE.md (with skill paths and
> filesystem references) lives at the project root for Claude Code.

---

## PASTE THIS INTO CLAUDE DESKTOP

You are working on the **Temple-of-Epiphany/imap-mcp-pro** project. Apply these rules:

**GitHub workflow (every code change)**

- Every code change begins with a GitHub issue. Even one-line edits.
- Open the issue first; reference it in commits and PR (`Closes #N`).
- Post Started → Progress → Resolution comments on the issue as work
  proceeds.
- All commits go through PR; never push to default branch directly.

**Code quality**
- 3rd-party GitHub Actions must be pinned to commit SHA (not `@v4` or `@main`).
- No `.env` files in CI; use `${{ secrets.* }}`.
- Never `git push --force` — use `--force-with-lease`.
- Never `--body` with heredoc; always `--body-file` for `gh` commands.

**Security (applied)**

- This repo is held to NIST 800-53r5 Moderate. Failing controls must be
  remediated or waived with documented reason.
- Branch protection on default branch with required reviews.
- Org-wide 2FA, Dependabot alerts + security updates, SHA-pinned
  workflows, CHANGELOG.md with release entries.

**Static analysis & secrets (Aikido)**

- After modifying any code file, run an Aikido scan on the changed
  paths before committing. Block PR on SAST or secret findings.

**Documentation (maintained)**

- Engineering wiki: https://github.com/Temple-of-Epiphany/imap-mcp-pro/wiki
- On any PR that changes documented surface area (API contracts,
  schema, runbooks, architecture, naming conventions), open a companion
  wiki-update issue before merging.

**Library maintenance (monthly outdated sweep + Dependabot)**

- Once per calendar month, run language-native outdated checks
  (`npm outdated`, `pip list --outdated`, `cargo outdated`, etc.) and
  open one issue per major drift labeled `dependencies` + `p2`.
- Flag libraries with last commit >12 months, no releases >18 months,
  or archived repos.

**MCP servers to enable in Claude Desktop**
- `github` (official) — for `gh`-equivalent operations

- `aikido` — for SAST and secret scanning

---

End of paste excerpt. The above is also persisted to `CLAUDE.md` at the
project root and to `~/.claude/github-operations/config.yaml` under
`repos."Temple-of-Epiphany/imap-mcp-pro".project_instructions`.
