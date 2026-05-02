/**
 * package-info.ts — single source of truth for the project's name + version.
 *
 * Reads `package.json` once at module load. Use this instead of hardcoded
 * version strings anywhere the value is exposed to users (MCP serverInfo,
 * imap_about response, web UI banner). Bumping `package.json` then becomes
 * the only step needed to make the new version visible everywhere.
 *
 * Path resolution:
 *   - In dev (tsx src/...): __dirname is src/utils → ../../package.json works
 *   - In dist (node dist/utils/...): __dirname is dist/utils → ../../package.json
 *     resolves to the repo root in development and to server/package.json
 *     when bundled into the .mcpb (where dist/ lives at server/dist/).
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-01
 * Version: 0.1.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', '..', 'package.json');

interface PackageJson {
  name: string;
  version: string;
}

let cached: PackageJson | undefined;
function readPkg(): PackageJson {
  if (cached) return cached;
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PackageJson>;
    cached = {
      name: typeof parsed.name === 'string' ? parsed.name : 'imap-mcp-pro',
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    };
  } catch {
    // Fallback: never crash the server because package.json couldn't be read.
    cached = { name: 'imap-mcp-pro', version: '0.0.0' };
  }
  return cached;
}

export const PACKAGE_NAME: string = readPkg().name;
export const PACKAGE_VERSION: string = readPkg().version;
