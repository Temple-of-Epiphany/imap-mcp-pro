// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tool profiles (#293). The server registers ~130 MCP tools; some hosts
// (observed: the Claude Desktop Cowork bridge) announce the full set but
// surface none of them to the session. A `core` profile exposes a small
// everyday subset so the tool count can be reduced without touching any
// tool module: the filter lives in the registerTool wrapper in ./index.ts
// and this file is the single list of what `core` contains.

export type ToolProfile = 'full' | 'core';

/** Environment variable the profile is read from (set via the .mcpb `tool_profile` user_config). */
export const TOOL_PROFILE_ENV = 'IMAP_MCP_TOOL_PROFILE';

export const TOOL_PROFILES: readonly ToolProfile[] = ['full', 'core'];

/**
 * Everyday tools exposed by the `core` profile. Keep this list small (target
 * 25–30); anything not listed is hidden when the profile is `core`. The
 * discovery tools stay in so a session can always see what is hidden.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set<string>([
  // discovery / self-information
  'imap_list_tools',
  'imap_help',
  'imap_about',
  'imap_open_web_ui',
  // accounts
  'imap_list_users',
  'imap_list_accounts',
  'imap_db_list_accounts',
  'imap_test_account',
  // read
  'imap_search_emails',
  'imap_search_cache',
  'imap_get_email',
  'imap_get_latest_emails',
  'imap_get_unread_count',
  'imap_get_attachment',
  // send
  'imap_send_email',
  'imap_reply_to_email',
  'imap_forward_email',
  'imap_get_outbox_dir',
  // folders
  'imap_list_folders',
  'imap_folder_status',
  'imap_get_mailbox_status',
  // flags / move / delete
  'imap_mark_as_read',
  'imap_mark_as_unread',
  'imap_bulk_mark_emails',
  'imap_move_email',
  'imap_copy_email',
  'imap_delete_email',
  'imap_bulk_move_emails',
  'imap_bulk_delete_emails',
]);

/**
 * Parse a profile name from the environment. Unknown or empty values fall
 * back to `full` (never hide tools because of a typo); `warn` is called with
 * a message when a non-empty value was not recognised.
 */
export function resolveToolProfile(
  raw: string | undefined,
  warn: (msg: string) => void = () => {}
): ToolProfile {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'full';
  if ((TOOL_PROFILES as readonly string[]).includes(value)) return value as ToolProfile;
  warn(`[tool-profile] Unknown ${TOOL_PROFILE_ENV}="${raw}" — expected one of ${TOOL_PROFILES.join(', ')}; using "full".`);
  return 'full';
}

/** Whether a tool is registered under the given profile. */
export function isToolVisible(toolName: string, profile: ToolProfile): boolean {
  return profile === 'full' || CORE_TOOLS.has(toolName);
}

/** What the last registerTools() pass did, for imap_list_tools to report. */
export interface ToolProfileState {
  profile: ToolProfile;
  /** Tools registered on the server. */
  registered: string[];
  /** Tools skipped because the profile hides them (empty for `full`). */
  hidden: string[];
}

let activeState: ToolProfileState = { profile: 'full', registered: [], hidden: [] };

/** @internal set by registerTools() after each registration pass. */
export function setActiveToolProfile(state: ToolProfileState): void {
  activeState = {
    profile: state.profile,
    registered: [...state.registered],
    hidden: [...state.hidden],
  };
}

/** Profile and hidden-tool list from the most recent registerTools() pass. */
export function getActiveToolProfile(): ToolProfileState {
  return {
    profile: activeState.profile,
    registered: [...activeState.registered],
    hidden: [...activeState.hidden],
  };
}
