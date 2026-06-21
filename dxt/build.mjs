#!/usr/bin/env node
/**
 * dxt/build.mjs — build a Claude Desktop Extension (.mcpb) for imap-mcp-pro
 *
 * Steps:
 *   1. Read version from package.json
 *   2. Run npm run build to produce dist/
 *   3. Stage server/ (dist/ + node_modules/) under dxt/build/server/
 *   4. Rebuild native modules for the target platform (better-sqlite3)
 *   5. Copy icon, screenshots, and merged manifest into dxt/build/
 *   6. Generate tools array via `node dist/index.js --print-tools-manifest`
 *      and merge into manifest.json
 *   7. Zip dxt/build/ into dxt/build/imap-mcp-pro-{version}-{platform}.mcpb
 *   8. Compute SHA-256 alongside
 *
 * Usage:
 *   node dxt/build.mjs                  # build for current platform
 *   node dxt/build.mjs --skip-rebuild   # skip npm rebuild (faster, native
 *                                       # bindings stay as-installed)
 *   node dxt/build.mjs --skip-zip       # build the layout, skip the zip
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-29
 * Version: 0.1.0
 *
 * Tracker: #102. Phase 4 issue: #106.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dxtDir = __dirname;
const buildDir = path.join(dxtDir, 'build');
const serverDir = path.join(buildDir, 'server');

const args = new Set(process.argv.slice(2));
const skipRebuild = args.has('--skip-rebuild');
const skipZip = args.has('--skip-zip');
// Universal mode: the runtime is pure JS (node:sqlite, no native deps), so one
// bundle runs on every platform. Drops the platform suffix from the archive
// name (imap-mcp-pro-<version>.mcpb) — used for the single MCP Registry artifact.
const universal = args.has('--universal');

function log(...m) {
  process.stderr.write(`[dxt/build] ${m.join(' ')}\n`);
}

function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function cpr(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

function platformLabel() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'darwin') return a === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (p === 'win32') return 'windows-x64';
  if (p === 'linux') return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
  return `${p}-${a}`;
}

// 1. Read version
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
log(`version: ${version}`);
const platform = platformLabel();
log(`platform: ${platform}`);

// 2. Clean and build
rmrf(buildDir);
fs.mkdirSync(buildDir, { recursive: true });
run('npm run build');

// 3. Stage server/
fs.mkdirSync(serverDir, { recursive: true });
cpr(path.join(repoRoot, 'dist'), path.join(serverDir, 'dist'));
cpr(path.join(repoRoot, 'node_modules'), path.join(serverDir, 'node_modules'));
cpr(path.join(repoRoot, 'package.json'), path.join(serverDir, 'package.json'));
cpr(path.join(repoRoot, 'package-lock.json'), path.join(serverDir, 'package-lock.json'));

// Ship the license + copyright notice with the bundle. The manifest declares
// LicenseRef-ImapMcpPro-Dual; these files carry the actual terms and copyright.
for (const legal of ['LICENSE', 'NOTICE']) {
  const srcLegal = path.join(repoRoot, legal);
  if (fs.existsSync(srcLegal)) {
    cpr(srcLegal, path.join(buildDir, legal));
    cpr(srcLegal, path.join(serverDir, legal));
  }
}

// Trim node_modules: drop devDependencies-only packages and obvious bloat
function pruneNodeModules() {
  const nm = path.join(serverDir, 'node_modules');
  // Drop typescript, tsx, nodemon, @types/* — devDependencies-only at runtime
  const drop = [
    'typescript',
    'tsx',
    'nodemon',
    'electron',           // 300+ MB — only used as a devDep for testing
    '@electron',          // any sub-packages
  ];
  for (const d of drop) {
    rmrf(path.join(nm, d));
  }
  // Drop @types/* — pure type declarations, runtime doesn't need them
  const typesDir = path.join(nm, '@types');
  if (fs.existsSync(typesDir)) rmrf(typesDir);
  // Drop SDK source maps + .ts source from node_modules (keeps bundle tight)
  // Keep this conservative — only drop *.map files
  const stack = [nm];
  while (stack.length) {
    const cur = stack.pop();
    if (!fs.existsSync(cur)) continue;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith('.map')) {
        fs.unlinkSync(full);
      }
    }
  }
}
pruneNodeModules();

// 4. Native module rebuild — no longer needed.
//
// We migrated from better-sqlite3 to node:sqlite (Node 22.5+ built-in)
// in v2.16. node:sqlite ships inside Node itself, so its native binding
// inherits the host process's code signature. This means it loads cleanly
// inside macOS-hardened apps like Claude Desktop, where third-party
// .node binaries are rejected by library-validation regardless of which
// Electron headers they were built against.
//
// If a future native dep gets reintroduced, mirror the previous
// `npm rebuild --runtime=electron --target=...` pattern here.
void skipRebuild;

// 5. Copy assets
cpr(path.join(dxtDir, 'icon.png'), path.join(buildDir, 'icon.png'));
const screenshotsSrc = path.join(dxtDir, 'screenshots');
if (fs.existsSync(screenshotsSrc) && fs.readdirSync(screenshotsSrc).length > 0) {
  cpr(screenshotsSrc, path.join(buildDir, 'screenshots'));
}

// 6. Build manifest with version + tools array
const tplPath = path.join(dxtDir, 'manifest.template.json');
const manifest = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
manifest.version = version;

let toolsManifest;
try {
  const out = execSync('node dist/index.js --print-tools-manifest', {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  toolsManifest = JSON.parse(out);
} catch (e) {
  log(`ERROR: failed to generate tools manifest: ${e.message}`);
  process.exit(1);
}

// Per the MCPB manifest spec (manifest v0.3), tools entries take only
// `name` and `description`. The full inputSchema lives on the server
// itself and is fetched via tools/list at runtime; the manifest is just
// for the extension store / settings UI.
manifest.tools = toolsManifest.tools.map((t) => ({
  name: t.name,
  description: t.description ?? '',
}));

log(`merged ${manifest.tools.length} tools into manifest`);

fs.writeFileSync(
  path.join(buildDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

// 7. Zip
if (skipZip) {
  log('--skip-zip set; layout written to dxt/build/');
  process.exit(0);
}

const archiveName = universal
  ? `imap-mcp-pro-${version}.mcpb`
  : `imap-mcp-pro-${version}-${platform}.mcpb`;
const archivePath = path.join(dxtDir, 'build', archiveName);

// Use system zip on macOS/Linux; on Windows use PowerShell Compress-Archive.
log(`creating ${archiveName}`);
if (process.platform === 'win32') {
  // Compress-Archive can't preserve file modes, but .mcpb doesn't need them.
  run(
    `powershell -Command "Compress-Archive -Path 'manifest.json','icon.png','server'${
      fs.existsSync(path.join(buildDir, 'screenshots')) ? ",'screenshots'" : ''
    } -DestinationPath '${archivePath.replace(/\\/g, '\\\\')}' -Force"`,
    { cwd: buildDir, stdio: 'inherit' }
  );
} else {
  // -X strips macOS extended attrs; -r recursive
  const items = ['manifest.json', 'icon.png', 'server'];
  if (fs.existsSync(path.join(buildDir, 'screenshots'))) items.push('screenshots');
  // Move archive out of buildDir to avoid recursing into itself
  const tmpArchive = path.join(os.tmpdir(), archiveName);
  rmrf(tmpArchive);
  execSync(`zip -X -r -q '${tmpArchive}' ${items.map((i) => `'${i}'`).join(' ')}`, {
    cwd: buildDir,
    stdio: 'inherit',
  });
  fs.renameSync(tmpArchive, archivePath);
}

// 8. Compute SHA-256
const buf = fs.readFileSync(archivePath);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
fs.writeFileSync(`${archivePath}.sha256`, `${sha}  ${archiveName}\n`);
log(`SHA-256: ${sha}`);
log(`built: ${archivePath} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
log('done.');
