# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in IMAP MCP Pro, **please do not open a public GitHub issue**. Instead, report it privately so we can investigate and fix it before disclosure.

### How to report

Email **colin.bitterfield@templeofepiphany.com** with:

- A description of the vulnerability and its impact
- Steps to reproduce (proof of concept welcome)
- The affected version(s) — check `package.json` or `imap_about` tool output
- Your name and contact info if you'd like credit; you can also report anonymously

You should expect an acknowledgement within **3 business days**. We'll keep you updated as we investigate and prepare a fix.

### Scope

In scope:

- The MCP server (`src/`, `dist/`)
- Account credential storage (`~/.imap-mcp/data.db`, `~/.imap-mcp/.encryption-key`)
- The Claude Desktop Extension package (`.mcpb`)
- Build pipeline (`dxt/build.mjs`, `scripts/postbuild.mjs`)
- IMAP / SMTP transport, attachment handling, unsubscribe execution

Out of scope:

- Vulnerabilities in upstream dependencies — please report those to the maintainers (`npm audit` will surface them; we'll pick up fixes via dependency updates)
- Vulnerabilities in IMAP servers themselves (Gmail, Outlook, etc.)
- Vulnerabilities in Claude Desktop, the MCP SDK, or other Anthropic software — see [https://www.anthropic.com/security](https://www.anthropic.com/security)
- Social-engineering attacks against account holders

### Disclosure timeline

- **Day 0**: Report received, acknowledged within 3 business days.
- **Day 0–30**: We investigate, develop a fix, and prepare a release.
- **Day 30 (target)**: Fix released. We coordinate with you on disclosure timing.
- **Day 30–90**: Public disclosure. Reporters credited in the release notes unless they opt out.

If a vulnerability is being actively exploited, we'll move faster and may publish before the 30-day target.

## Supported Versions

Security fixes are backported to the **most recent minor release** (e.g., `2.16.x` while `2.17.x` is current). Older minor versions receive fixes only for vulnerabilities rated High or Critical.

| Version | Supported          |
| ------- | ------------------ |
| 2.17.x  | ✅                 |
| 2.16.x  | ✅ (latest before) |
| 2.15.x  | ⚠️  high/critical only |
| < 2.15  | ❌                 |

## What we promise

- Encrypted credential storage at rest (AES-256-GCM with a per-install key in `~/.imap-mcp/.encryption-key`, `chmod 600`).
- TLS for all IMAP/SMTP traffic by default; STARTTLS supported where the server requires it.
- Path-based attachments validated against an allowed-dirs whitelist with realpath + symlink-target checks (RFC 2183 filename sanitization).
- No telemetry. The server makes no outbound HTTP calls except those the user explicitly invokes (e.g., `imap_check_email_spam` calling UserCheck, `imap_execute_unsubscribe` opening a List-Unsubscribe URL).

## What we ask of you

- If you're deploying for multiple users (MSP scenarios), use the per-user model documented in `README.md`. Don't share `~/.imap-mcp/data.db` across users.
- Keep `~/.imap-mcp/.encryption-key` secret. Loss of this file means the encrypted credentials are unrecoverable; theft means they're decryptable.
- Apply security updates promptly when we publish them.

Thank you for helping keep IMAP MCP Pro secure.
