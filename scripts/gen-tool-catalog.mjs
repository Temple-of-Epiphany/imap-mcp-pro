#!/usr/bin/env node
/**
 * gen-tool-catalog.mjs — generate docs/TOOL_CATALOG.md from the live tool manifest.
 *
 * Reads the authoritative tool list (name + description) straight from the
 * built server (`node dist/index.js --print-tools-manifest`), buckets the tools
 * into stable categories, and writes a Markdown catalog. Run from postbuild so
 * the catalog can never drift from the registered tools again (#201).
 *
 * Author:        Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
 * Part of:       IMAP MCP Pro (Temple of Epiphany)
 * Date Created:  2026-06-21
 * Date Updated:  2026-06-21
 * Version:       1.0.0
 *
 * Changelog:
 *   1.0.0 (2026-06-21) — initial: manifest → categorized docs/TOOL_CATALOG.md.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');
const outPath = path.join(repoRoot, 'docs', 'TOOL_CATALOG.md');

// Category rules live in src/tools/tool-catalog.ts (#302) so this document and
// imap_list_tools can never disagree. Loaded from the built server.
const { categoryFor: categoryForTool, TOOL_CATEGORIES } = await import(path.join(repoRoot, 'dist', 'tools', 'tool-catalog.js'));
const CATEGORIES = TOOL_CATEGORIES.map((c) => [c.label, c.match]);
function categoryFor(name) {
  return categoryForTool(name).label;
}

function loadManifest() {
  if (!existsSync(distEntry)) {
    throw new Error(`Built server not found at ${distEntry} — run "npm run build" first.`);
  }
  // Point the spawned server at a throwaway DB so generating docs during a
  // build never touches the developer's real ~/.imap-mcp/data.db.
  const throwawayDb = path.join(tmpdir(), `imap-mcp-catalog-${process.pid}.db`);
  const raw = execFileSync('node', [distEntry, '--print-tools-manifest'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, IMAP_MCP_DATABASE_PATH: throwawayDb },
  });
  return JSON.parse(raw);
}

function firstSentence(desc) {
  const s = String(desc || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : s).slice(0, 240);
}

function render(tools) {
  const byCat = new Map(CATEGORIES.map(([label]) => [label, []]));
  byCat.set('Other', []);
  for (const t of tools) byCat.get(categoryFor(t.name)).push(t);

  const lines = [];
  lines.push('# Tool Catalog');
  lines.push('');
  lines.push('> **Generated file — do not edit by hand.** Produced from the live tool');
  lines.push('> manifest by `scripts/gen-tool-catalog.mjs` (runs on `npm run build`).');
  lines.push('> The authoritative runtime list is always available via the `imap_list_tools` tool.');
  lines.push('');
  lines.push(`**${tools.length} MCP tools** total.`);
  lines.push('');

  // Table of contents with per-category counts.
  lines.push('## Categories');
  lines.push('');
  for (const [label] of [...CATEGORIES, ['Other']]) {
    const items = byCat.get(label);
    if (!items || items.length === 0) continue;
    const anchor = label.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '-');
    lines.push(`- [${label}](#${anchor}) — ${items.length}`);
  }
  lines.push('');

  for (const [label] of [...CATEGORIES, ['Other']]) {
    const items = byCat.get(label);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${label}`);
    lines.push('');
    lines.push('| Tool | Description |');
    lines.push('| --- | --- |');
    for (const t of items) {
      lines.push(`| \`${t.name}\` | ${firstSentence(t.description).replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

const manifest = loadManifest();
const tools = (manifest.tools || []).slice().sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(outPath, render(tools));
console.log(`[gen-tool-catalog] wrote ${path.relative(repoRoot, outPath)} (${tools.length} tools)`);
