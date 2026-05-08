/**
 * Lint-style guard against XML/HTML-like patterns in tool descriptions.
 *
 * Why this exists: in v2.17.13 we shipped tool descriptions containing
 * `<userId>` and `<name>` as placeholder syntax. Claude Desktop's tool
 * dispatcher hangs on those tools indefinitely (issue #155) — apparently
 * an XML/HTML sanitizer somewhere in the client trips on the bracket pair.
 * v2.17.14 replaced the placeholders with curly-brace `{name}` form. This
 * test ensures no future contributor reintroduces the pattern.
 *
 * Scope: scans every `description: '...'` and `.describe('...')` string in
 * `src/tools/**.ts` for `<word>`-style patterns. Allowlists obvious-non-XML
 * cases (URLs, code-block angle brackets, comparison operators).
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-08
 * Version: 0.1.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = __dirname; // src/tools

function listToolFiles(): string[] {
  return fs.readdirSync(TOOLS_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => path.join(TOOLS_DIR, f));
}

/**
 * Match a JS/TS string literal (single, double, or template) and return its
 * raw inner content. Approximate — does not handle every edge case (escaped
 * quotes inside, etc.) but is robust enough for our tool description shape.
 */
function* iterStringLiterals(source: string): Generator<{ content: string; line: number }> {
  // Single quote, double quote, or backtick. Greedy until matching closer,
  // not respecting escapes for simplicity (false-positives are acceptable
  // for a lint-style check).
  const re = /(['"`])((?:(?!\1)[\s\S])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const before = source.slice(0, m.index);
    const line = before.split('\n').length;
    yield { content: m[2], line };
  }
}

const ANGLE_TOKEN = /<([A-Za-z][A-Za-z0-9_]*)>/g;

const ALLOWED_TOKENS = new Set<string>([
  // Common HTML/email tags that legitimately show up in error messages
  // about email body parsing.
  'html', 'head', 'body', 'br', 'p', 'div', 'span',
  'a', 'b', 'i', 'em', 'strong',
  'unnamed', // used in 'Inline attachment <unnamed>' formatter
]);

describe('tool descriptions — no XML-like placeholders', () => {
  it('no <name>-style angle-bracket tokens in any tool string literal', () => {
    const offenders: Array<{ file: string; line: number; token: string; snippet: string }> = [];

    for (const file of listToolFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      for (const { content, line } of iterStringLiterals(source)) {
        if (!content.includes('<')) continue;
        let m: RegExpExecArray | null;
        const local = new RegExp(ANGLE_TOKEN.source, 'g');
        while ((m = local.exec(content)) !== null) {
          const tok = m[1];
          if (ALLOWED_TOKENS.has(tok.toLowerCase())) continue;
          offenders.push({
            file: path.relative(path.resolve(__dirname, '..', '..'), file),
            line,
            token: `<${tok}>`,
            snippet: content.slice(Math.max(0, m.index - 30), m.index + tok.length + 32),
          });
        }
      }
    }

    if (offenders.length > 0) {
      const report = offenders
        .map(o => `${o.file}:${o.line}  token=${o.token}\n    "...${o.snippet}..."`)
        .join('\n');
      throw new Error(
        `Found XML/HTML-like placeholder tokens in tool source. ` +
        `Claude Desktop's dispatcher hangs on these (#155). ` +
        `Use curly-brace {name} form instead.\n\n${report}`
      );
    }

    expect(offenders.length).toBe(0);
  });
});
