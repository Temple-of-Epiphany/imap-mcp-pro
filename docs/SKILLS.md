# Skills

> **What:** Markdown instructions that teach Claude how to use this MCP's tools for specific workflows. Bundled with the `.mcpb`, auto-installed to `~/.claude/skills/imap-mcp-pro/`, and updateable from public GitHub without rebuilding the extension.

**Introduced in:** v2.17.0 (auto-install). Update tooling added in v2.17.4. Default source flipped to this repo in v2.17.5.

---

## TL;DR

- You don't install skills separately — they ship inside the `.mcpb` and auto-install on first server start.
- To check for newer skill versions: ask Claude *"Are there any updates available for my imap-mcp-pro skills?"* — it'll call `imap_check_skill_updates`.
- To apply an update: *"Update the unsubscribe-cleanup skill"* — Claude calls `imap_update_skills` with the explicit name.
- Updates fetch from this repo's `skills/` directory on `main`. No GitHub token required (this repo is public).
- Skills are *instructions to the LLM* — review what changes before applying, and only update from sources you trust.

---

## What skills are

A **skill** is a `SKILL.md` file with YAML frontmatter. It tells Claude how to compose this MCP's primitive tools into a higher-level workflow. For example, the `unsubscribe-cleanup` skill orchestrates `imap_sync_folder_cache`, `imap_search_cache`, `imap_get_unsubscribe_links`, and `imap_execute_unsubscribe` into a confirmation-gated newsletter-cleanup flow.

Without a skill, Claude has to figure out the workflow from raw tool descriptions every time. With a skill, the workflow — including its safety rules and edge-case handling — is consistent.

Skills are **not** code. They never execute on your machine. They're context that influences Claude's behavior when it sees relevant trigger phrases.

---

## Where skills live

| Location | Purpose |
|---|---|
| `skills/` (this repo) | **Source of truth.** One subdirectory per skill, plus a top-level `manifest.json` that lists them. |
| `dist/skills/` (build output) | Copied verbatim from `skills/` by `scripts/postbuild.mjs`. Bundled into the `.mcpb`. |
| `~/.claude/skills/imap-mcp-pro/` | Where Claude Desktop reads installed skills from. Populated by the auto-installer at server start. |

The flow is: `skills/` → `dist/skills/` (build) → bundled in `.mcpb` (release) → `~/.claude/skills/imap-mcp-pro/` (user install).

---

## Currently bundled

| Skill | Version | What it does |
|---|---|---|
| `unsubscribe-cleanup` | 0.1.1 | Find newsletter senders, present candidates for review, execute unsubscribes safely. Gmail-aware (defaults to `[Gmail]/All Mail` instead of `INBOX`). |

Future planned: `email-triage`, `correspondence-research` (placeholder issues filed; depend on additional MCP tools).

---

## How auto-install works

On every server startup (post-handshake stage), `SkillsInstallerService` runs:

1. Read `dist/skills/manifest.json` (or skip if missing).
2. For each skill in the manifest, compare the bundled `version.json` against `~/.claude/skills/imap-mcp-pro/<name>/version.json`.
3. **Missing** → copy the whole skill directory (`installed`).
4. **Bundled is newer** → overwrite (`updated`).
5. **Versions equal** → skip (`unchanged`).
6. **On-disk is newer than bundled** → leave alone (`preserved` — the user has a customization).
7. Log a one-line summary.

Disable entirely with `IMAP_MCP_SKIP_SKILLS_INSTALL=1`. Override the install path with `IMAP_MCP_SKILLS_PATH=/some/other/dir`.

---

## Updating skills (v2.17.4+)

Two MCP tools are exposed for users (or Claude on their behalf) to update skills from the public source repo without reinstalling the `.mcpb`.

### `imap_check_skill_updates` — read-only

Fetches `version.json` for every bundled skill from GitHub and compares against the installed copy.

```jsonc
// Example response
{
  "checkedAt": "2026-05-02T...",
  "source": { "owner": "Temple-of-Epiphany", "repo": "imap-mcp-pro", "ref": "main" },
  "baseUrl": "https://raw.githubusercontent.com/Temple-of-Epiphany/imap-mcp-pro/main/skills/",
  "skills": [
    {
      "name": "unsubscribe-cleanup",
      "installed": "0.1.1",
      "bundled": "0.1.1",
      "available": "0.1.2",
      "hasUpdate": true,
      "fetchError": null
    }
  ],
  "summary": "unsubscribe-cleanup: 0.1.1 → 0.1.2 available",
  "cached": false
}
```

`hasUpdate` is true only when `available > installed` (or `> bundled` if not yet installed).

**Make no on-disk changes** — this is purely informational.

### `imap_update_skills` — write

Applies the update for explicitly named skills. No "update everything" shortcut: you must pass the names.

```jsonc
// Example call:
imap_update_skills({
  skills: ["unsubscribe-cleanup"],   // required, non-empty
  ref: "main",                        // optional, default "main"
  force: false,                       // optional, bypass version-compare
  timeoutMs: 10000                    // optional, per-file network timeout
})
```

Behavior:

- Fetches `SKILL.md` and `version.json` from `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/skills/<name>/`.
- Skills not in the bundled `manifest.json` are **rejected** (the manifest is the allowlist).
- If on-disk version ≥ remote and `force` is false, the skill is **unchanged**.
- Returns the same `SkillsInstallReport` shape as the auto-installer.

---

## Trust model — important

Skills are **instructions to the LLM**. Whoever controls the source repo controls how Claude behaves when it loads the skill. To preserve user agency:

- **Updates are never automatic.** No background fetch, no startup pull. The user (or Claude on their explicit request) initiates every update.
- **The bundled `manifest.json` is the allowlist.** A skill name not in the manifest cannot be installed via the update tools, even if the repo contains a directory by that name.
- **User edits are preserved.** If you've modified `~/.claude/skills/imap-mcp-pro/<name>/SKILL.md` and bumped its `version.json` higher than the remote, the auto-installer and `imap_update_skills` both leave it alone (unless `force: true`).
- **The default source is this MCP's own public repo.** No third party, no token in the default path. If you fork or maintain skills elsewhere, you set environment variables and accept that trust trade-off.

If you're concerned about a skill update, run `imap_check_skill_updates` first, eyeball the SKILL.md diff at the GitHub URL it reports, and only call `imap_update_skills` once you've reviewed.

---

## Configuration (environment variables)

All optional. Sensible defaults are baked in.

| Variable | Default | Effect |
|---|---|---|
| `IMAP_MCP_SKIP_SKILLS_INSTALL` | unset | When `1`, the auto-installer no-ops on startup. Existing skills unchanged. |
| `IMAP_MCP_SKILLS_PATH` | `~/.claude/skills/imap-mcp-pro` | Where skills get installed. Override for non-Claude clients or custom layouts. |
| `IMAP_MCP_SKILL_GITHUB_OWNER` | `Temple-of-Epiphany` | GitHub org/user the update source lives under. |
| `IMAP_MCP_SKILL_GITHUB_REPO` | `imap-mcp-pro` | GitHub repo the update source lives in. Default is **this repo itself** since it bundles the skills. |
| `IMAP_MCP_SKILL_GITHUB_REF` | `main` | Branch, tag, or commit SHA. Pin to a tag for reproducible updates. |
| `IMAP_MCP_GITHUB_TOKEN` | unset | Optional Personal Access Token. When set, fetches go through the GitHub Contents API with `Accept: application/vnd.github.raw`. Required for private repos and forks. Not needed for the default public-fetch path. |

---

## Troubleshooting

### `imap_check_skill_updates` returns `fetchError: "GitHub returned 404 ..."`

The source repo is private (or the path doesn't exist on the configured `ref`). Either:
- Set `IMAP_MCP_GITHUB_TOKEN` to a PAT with `repo:read` scope, or
- Switch `IMAP_MCP_SKILL_GITHUB_REPO` to a public repo that has the skill, or
- Make your private skills repo public.

Default source (`Temple-of-Epiphany/imap-mcp-pro@main`) is public — if you're seeing 404 against the default, the requested `ref` may not exist yet (e.g., the skill hasn't been merged to that branch).

### Tool reports `unknown — not in bundle manifest` in `preserved`

The skill name you passed to `imap_update_skills` isn't in the `.mcpb`'s `manifest.json`. That's the allowlist — only known skills can be updated via this path. To add a skill: rebuild the `.mcpb` with the new entry in `skills/manifest.json`.

### Skill update succeeded but Claude still uses the old version

Claude Desktop reads skills from `~/.claude/skills/` at conversation start, not on every prompt. Start a new conversation (or restart Claude Desktop) to pick up the new content.

### My customizations got overwritten

By default, the installer/update tools preserve on-disk content when the on-disk `version.json` is higher than the bundled/remote version. Bump your local version higher than the source you're protecting against. If you used `force: true`, that bypasses the protection — re-edit and bump.

### `IMAP_MCP_GITHUB_TOKEN` is set but updates still 404

Token doesn't have read access to the configured repo, or the token is expired. Run `gh auth status` (if you used `gh auth token`) or generate a fresh PAT at https://github.com/settings/tokens with `repo:read` scope.

---

## For contributors: adding a new skill

1. Create the skill directory under `skills/`:

   ```
   skills/<your-skill-name>/
     ├── SKILL.md         # frontmatter + markdown body
     └── version.json     # name, version, depends_on
   ```

2. Add it to `skills/manifest.json`:

   ```jsonc
   {
     "manifest_version": "1.0",
     "publisher": "imap-mcp-pro",
     "publisher_version": "2.17.5",
     "skills": [
       /* ... existing entries ... */
       {
         "name": "your-skill-name",
         "version": "0.1.0",
         "description": "One-sentence summary, < 200 chars.",
         "content_path": "your-skill-name/SKILL.md",
         "content_format": "markdown",
         "depends_on_tools": ["imap_..."],
         "min_mcp_server_version": "2.17.0"
       }
     ]
   }
   ```

3. Run `npm run build` — `scripts/postbuild.mjs` will copy `skills/` into `dist/skills/` and the next `.mcpb` build will bundle it.

4. Manually test by running `npx tsx scripts/smoke-test-skills-install.ts` against a tmpdir to verify the install logic.

5. PR with a CHANGELOG entry under the next version.

### Versioning rules

- Use **semver** (`major.minor.patch`).
- Bump **patch** for typo fixes, clarifications, prompt-engineering tweaks that don't change behavior.
- Bump **minor** for new workflow steps, new safety rules, additional input/output fields surfaced to the user.
- Bump **major** for breaking changes that would confuse users following the previous version (e.g., renamed steps, removed warnings the user relied on).

The auto-installer treats *any* version increment as "newer" and overwrites. Pre-release identifiers (`0.2.0-rc.1` etc.) are handled simplistically — patch-level only — by the installed version of `compareSemver`. If you need real prerelease semantics, file an issue.

### Skill content conventions

Existing skills follow these patterns. New skills should match for consistency.

- **YAML frontmatter** (required): `name`, `version`, `description`, `date_created`, `date_updated`.
- **Markdown body** organized as: `## Overview`, `## When to Use`, `## Required MCP Tools`, `## Workflow` (numbered steps), `## Safety Rules`, `## Output Format` (if applicable).
- **No tool-call XML.** `<ask_user_input_v0>`, `<ChoicePrompt>`, etc. render as raw text in Claude Desktop. Use plain Markdown numbered lists for any user-facing question.
- **Provider-specific quirks** documented inline. E.g., Gmail's tabbed inbox vs. IMAP `INBOX` mismatch is in `unsubscribe-cleanup`'s "Folder selection" section.
- **Trust contract** stated up front. What the skill will/won't do without explicit user confirmation.

---

## Architecture notes

### Why skills ship with the MCP

We considered three distribution models:

1. **Bundled with the MCP** *(chosen)* — skills live in this repo, build into the `.mcpb`, auto-install on server start. Single distribution, single trust boundary, no separate install step.
2. **Separate `claude-skills-library`** — every MCP pulls from a shared registry. Tried in v2.17.4. Cross-repo dependency, separate trust model, requires a token because the registry was private.
3. **Per-skill repos** *(deferred)* — `imap-mcp-pro-unsubscribe-cleanup` etc. Useful only when one skill is consumed by multiple MCPs, which we don't have yet.

The current model: skills bundled with their parent MCP. The MCP's own (public) repo is the canonical update source. Cross-cutting / standalone skills can still live in `claude-skills-library` for cross-MCP sharing — that just isn't the default path for skills like `unsubscribe-cleanup` that only exist for this MCP.

### Why skills are markdown, not code

Skills are read by Claude as instructions, not executed by Node. Markdown:

- Is reviewable as plain text in any editor or git diff.
- Can't accidentally introduce a security vulnerability (it's not code).
- Versions cleanly with content-based hashing.
- Survives any future LLM that reads natural language.

### Why the manifest is the allowlist

`imap_update_skills` only accepts skill names that appear in the bundled `manifest.json`. Without that gate, a malicious caller could pass any directory name and try to fetch arbitrary content under `skills/<name>/`. Anchoring on the manifest restricts the update surface to skills the MCP actually ships.

---

## See also

- `CHANGELOG.md` — release history (skill changes flagged in entries with the relevant tool/feature)
- `~/.claude/skills/imap-mcp-pro/` — your installed skill content
- `skills/` — this repo's source-of-truth skill directory
- `src/services/skills-installer-service.ts` — the implementation
- `src/tools/skills-tools.ts` — the MCP tool wrappers (`imap_check_skill_updates`, `imap_update_skills`)
- Issues: [#120 (full installer scope)](https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues/120), [#138 (update from GitHub)](https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues/138)
