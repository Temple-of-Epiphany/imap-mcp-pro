# Privacy Policy — IMAP MCP Pro

**Last updated:** 2026-07-04
**Publisher:** Temple of Epiphany
**Contact:** colin.bitterfield@templeofepiphany.com

IMAP MCP Pro is a **local** Model Context Protocol (MCP) server that runs on your
own device (as a Claude Desktop `.mcpb` extension or a local process). It connects
directly to the email accounts *you* configure. This policy describes what data it
handles, where that data lives, and when — if ever — data leaves your machine.

## Summary

- **Runs locally.** All processing happens on your device. The publisher operates
  no servers and receives none of your data.
- **No telemetry or analytics.** The extension collects no usage data and phones
  home to no one.
- **Your data stays local** unless *you* enable an optional integration or perform
  an action (sending mail, a spam/DNS lookup) that inherently contacts a third
  party you chose.

## What data is processed

- **Email account credentials** (username, password/app-password, host/port, and
  SMTP settings) that you enter.
- **Email content and metadata** (headers, subjects, senders, bodies, attachments,
  flags, folder structure) fetched from *your* mail servers when you ask Claude to
  search, read, organize, export, or send mail.
- **Optional API keys** you supply for integrations (e.g. a UserCheck API key).

## Where data is stored

- Everything is stored **on your device**, under `~/.imap-mcp/`:
  - Credentials are **encrypted at rest with AES-256-GCM** using a file-based key
    (`~/.imap-mcp/.encryption-key`, mode `0600`).
  - The local SQLite database, cache, staged uploads, and exported files are
    written with **owner-only permissions** (`0700`/`0600`).
- The publisher never receives, stores, or has access to any of this.

## When data leaves your device (only at your direction)

- **Your mail servers** — the IMAP/SMTP servers you configure receive your
  credentials and the commands/messages needed to read and send your mail. This is
  the core function of the tool.
- **UserCheck (optional)** — if you configure a UserCheck API key and run a spam
  check, sender email addresses are sent to `usercheck.com` to assess reputation.
  Results are cached locally.
- **DNS-over-HTTPS provider (optional)** — DNS-firewall checks send domain names to
  the configured provider (default: Quad9, `dns.quad9.net`) over HTTPS.
- **Anthropic / Claude** — as an MCP tool, results you request are returned to the
  Claude client you are using, subject to Anthropic's own privacy terms.

No other third parties receive your data, and nothing is sent to the publisher.

## Data retention & deletion

- Data persists **locally** only until you delete it. You are in full control:
  - Remove an account, clear the local cache/lists, or delete `~/.imap-mcp/`.
  - Uninstalling the extension and removing that directory erases all local state.
- There is **no server-side retention** because there is no server operated by the
  publisher.

## Security

Credentials are encrypted at rest (AES-256-GCM); the data directory and database
are owner-only. See [`SECURITY.md`](SECURITY.md) for the full security posture and
how to report a vulnerability.

## Children & sensitive data

IMAP MCP Pro is a general-purpose email tool and is not directed at children. It
does not intentionally process special-category data beyond whatever exists in the
mailboxes you connect.

## Changes

Material changes to this policy will be recorded here and in
[`CHANGELOG.md`](CHANGELOG.md).

## Contact

Questions about this policy: **colin.bitterfield@templeofepiphany.com**
