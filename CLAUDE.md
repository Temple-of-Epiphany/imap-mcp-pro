# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an IMAP MCP (Model Context Protocol) server built with TypeScript that provides comprehensive IMAP email integration with secure account management and connection pooling.

## Common Development Commands

- Build the project: `npm run build`
- Run in development mode: `npm run dev`
- Start the compiled server: `npm start`
- Install dependencies: `npm install`

## Architecture

### Core Components

1. **MCP Server (`src/index.ts`)**: The main entry point that sets up the MCP server using the McpServer class from the MCP SDK.

2. **Services**:
   - `ImapService`: Manages IMAP connections, email operations, and folder management with connection pooling
   - `DatabaseService`: Handles secure account/user storage (SQLite) with AES-256-GCM encryption and multi-tenant support

3. **Tools**: MCP tools are organized into three categories:
   - `account-tools.ts`: Account management (add, remove, list, connect, disconnect)
   - `email-tools.ts`: Email operations (search, read, mark, delete)
   - `folder-tools.ts`: Folder operations (list, status, unread counts)

### Key Design Decisions

- Uses `node-imap` for IMAP protocol implementation
- Implements connection pooling to efficiently manage multiple IMAP connections
- Stores encrypted credentials in `~/.imap-mcp/accounts.json`
- All MCP tools return JSON-formatted text responses
- TypeScript for type safety with comprehensive type definitions in `src/types/`

## Adding New Features

When adding new IMAP operations:
1. Add the operation to the appropriate service (`ImapService`)
2. Create or update the corresponding tool in the tools directory
3. Ensure proper error handling and connection management
4. Update types if needed in `src/types/index.ts`

## Important Constraints

- Later this library will be used for MSP services so each master account will have it's own subordinate email accounts. Security will need to be maintained. Do not make coding choices that will preclude this in the future.
- We are only going to test/install released versions. Either with a make install or a make update.

## IMAP4rev2 Compliance (RFC 9051)

This project implements IMAP4rev2 (RFC 9051) via the ImapFlow library. The full RFC is located at `rfc/rfc9051.txt`.

### Current Implementation Status

#### ✅ Implemented Core Commands
- **Connection**: LOGIN, LOGOUT, CAPABILITY, NOOP
- **Mailbox Selection**: SELECT, EXAMINE
- **Mailbox Management**: LIST (with SPECIAL-USE, LIST-STATUS support)
- **Message Operations**: SEARCH, FETCH, STORE (flags), COPY, MOVE
- **Deletion**: Message deletion with EXPUNGE
- **Authentication**: TLS/STARTTLS, AUTHENTICATE, PLAIN
- **Extensions**: IDLE, UIDPLUS, ESEARCH, NAMESPACE (via ImapFlow)

#### ✅ Mailbox Management & Message Append (Issue #50 — COMPLETE)
- **STATUS**: `imap_get_mailbox_status` (+ `imap_folder_status`)
- **CREATE**: `imap_create_folder`
- **DELETE**: `imap_delete_folder`
- **RENAME**: `imap_rename_folder`
- **APPEND**: `imap_append_message`
- **SUBSCRIBE / UNSUBSCRIBE**: `imap_subscribe_mailbox` / `imap_unsubscribe_mailbox` (+ `imap_list_subscribed_mailboxes`)
- A structural compliance regression suite (`src/tools/rfc9051-compliance.test.ts`, Issue #57) asserts each required command stays wired to a tool + ImapService method.

#### ⚠️ Available via ImapFlow (no dedicated MCP tool)
- **UNSELECT**, **ENABLE**

### IMAP4rev2 Built-in Extensions

The following are part of IMAP4rev2 base (no capability negotiation needed):
- NAMESPACE (RFC 2342) - ✅ Available via ImapFlow
- UNSELECT (RFC 3691) - ✅ Available via ImapFlow
- UIDPLUS (RFC 4315) - ✅ Available via ImapFlow
- ESEARCH (RFC 4731) - ✅ Supported
- SEARCHRES (RFC 5182) - ✅ Available via ImapFlow
- ENABLE (RFC 5161) - ✅ Available via ImapFlow
- IDLE (RFC 2177) - ✅ Available via ImapFlow
- SASL-IR (RFC 4959) - ✅ Available via ImapFlow
- LIST-EXTENDED (RFC 5258) - ✅ Available via ImapFlow
- LIST-STATUS (RFC 5819) - ✅ Available via ImapFlow
- MOVE (RFC 6851) - ✅ Implemented
- LITERAL- (RFC 7888) - ✅ Available via ImapFlow
- BINARY (RFC 3516) - ✅ Available via ImapFlow
- SPECIAL-USE (RFC 6154) - ✅ Supported
- STATUS=SIZE - ✅ Available via ImapFlow
- STATUS=DELETED - ✅ Available via ImapFlow

### Standard Flags (System Flags)
- `\Seen` - ✅ Implemented (mark read/unread)
- `\Answered` - ✅ Implemented (`imap_bulk_mark_emails` answered/unanswered; Issue #48)
- `\Flagged` - ✅ Implemented (flag/unflag)
- `\Deleted` - ✅ Implemented (delete operations)
- `\Draft` - ❌ Not yet implemented

### Recommended Keywords (SHOULD Support per RFC)
- `$Forwarded` - ❌ Not implemented
- `$MDNSent` - ❌ Not implemented
- `$Junk` - ❌ Not implemented
- `$NotJunk` - ❌ Not implemented
- `$Phishing` - ❌ Not implemented

### Special-Use Mailbox Attributes
These are recognized when present but not enforced:
- `\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent`, `\Trash`

### Security & TLS Compliance
- ✅ TLS 1.2+ via ImapFlow
- ✅ STARTTLS support
- ✅ Implicit TLS (port 993)
- ✅ Certificate validation
- ✅ Encrypted credential storage (AES-256-GCM)
- ✅ PLAIN SASL authentication
- ⚠️ Additional SASL mechanisms (SCRAM, GSSAPI) - via ImapFlow if server supports

### Compliance Roadmap

- **Issue #48** ✅: Priority flags (`imap_set/get_email_priority`) and `\Answered` support — DONE.
- **Issue #49** ✅: CAPABILITY query tool (`imap_get_capabilities`) — DONE.
- **Issue #50** ✅: Required commands (CREATE, DELETE, RENAME, APPEND, SUBSCRIBE/UNSUBSCRIBE, STATUS) — DONE.
- **Issue #57** ✅: RFC 9051 compliance regression suite (`src/tools/rfc9051-compliance.test.ts`) — DONE.
- Remaining (optional, not required for core compliance): Draft-flag tool surface and the recommended keywords ($Forwarded/$Junk/etc.) can be set today via `imap_add_keyword`.

### References
- RFC 9051 (IMAP4rev2): `rfc/rfc9051.txt`
- ImapFlow Documentation: https://imapflow.com/
- Related Issues: #48, #49, #50
- Check specification document when large modifications or replacements of code happen.