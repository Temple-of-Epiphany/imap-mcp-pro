/**
 * Shared userId resolver for MCP tools that write or query the database
 * by `users.user_id`.
 *
 * Background (#130, #145): tools that accept `userId` from the caller
 * historically inserted whatever string was passed, which produced
 * `FOREIGN KEY constraint failed` deep in INSERT paths when the caller
 * supplied the username (e.g., "colin") instead of the canonical UUID.
 * v2.17.2 introduced this resolver locally in subscription-tools.ts and
 * applied it to 8 subscription handlers. v2.17.7 extracts it here and
 * applies it consistently across the usercheck tools so every userId-
 * accepting MCP tool follows the same rule:
 *
 *   - canonical user_id UUID  → returned as-is if the row exists
 *   - username (e.g. "colin") → looked up; returns the matched user_id
 *   - neither matches         → throws UnknownUserError, which
 *                               withErrorHandling converts to a clean
 *                               error envelope with an actionable hint.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-03
 * Version: 0.1.0
 */

import { DatabaseService } from '../services/database-service.js';

/**
 * Thrown when the caller-supplied `userId` matches neither a UUID nor a
 * username row in the users table. `withErrorHandling` converts this
 * into a structured error response back to the LLM with a clear hint.
 */
export class UnknownUserError extends Error {
  constructor(provided: string) {
    super(
      `Unknown user: "${provided}". Pass a valid user_id (UUID) or a username ` +
      `that exists in the users table. Call imap_list_users to see valid values.`
    );
    this.name = 'UnknownUserError';
  }
}

/**
 * Resolve `userId` input (UUID or username) → canonical UUID. Throws
 * UnknownUserError if neither matches.
 */
export function resolveUserOrThrow(db: DatabaseService, input: string): string {
  const resolved = db.resolveUserId(input);
  if (!resolved) throw new UnknownUserError(input);
  return resolved;
}
