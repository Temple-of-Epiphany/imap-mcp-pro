// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Human-readable byte formatting.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)
//
// Single source of truth for rendering byte counts to users — adaptive units
// (B / KB / MB / GB / TB / PB) so nothing surfaces a raw "10000000000 bytes".

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Format a byte count as an adaptive human-readable string.
 *   512        -> "512 B"
 *   10240      -> "10.00 KB"
 *   10485760   -> "10.00 MB"
 *   2147483648 -> "2.00 GB"
 *
 * Uses binary (1024) steps. Values below 1 KB render as whole bytes; larger
 * values use two decimals. Negative/NaN inputs clamp to "0 B".
 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(2)} ${UNITS[unit]}`;
}
