#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// `imap-setup` — interactive setup wizard.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)
//
// Optionally registers this server in the Claude Desktop config, then launches
// the local web UI where accounts are configured. All actions are local.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline';
import chalk from 'chalk';
import ora from 'ora';
import { program } from 'commander';
import { WebUIServer } from './web/server.js';

const DEFAULT_PORT = '4500';

program
  .name('imap-setup')
  .description('IMAP MCP Server Setup Wizard')
  .option('-p, --port <port>', 'Port for web UI', DEFAULT_PORT)
  .option('--no-open', 'Do not open browser automatically')
  .option('--claude-setup', 'Setup Claude Desktop integration')
  .option('--skip-claude', 'Skip Claude Desktop integration')
  .parse();

const options = program.opts();

/** Per-platform location of the Claude Desktop config file. */
function claudeConfigPath(): string {
  const home = os.homedir();
  switch (os.platform()) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
    case 'linux':
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

/** Absolute path to the compiled server entry point. */
function serverEntryPath(): string {
  return path.join(process.cwd(), 'dist', 'index.js');
}

/** Read and parse an existing JSON config, or return `{}` if absent/unreadable. */
async function readJsonConfig(file: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return {};
  }
}

/** Print the manual config snippet as a fallback when auto-config fails. */
function printManualSnippet(serverPath: string): void {
  const snippet = [
    '  {',
    '    "mcpServers": {',
    '      "imap": {',
    '        "command": "node",',
    `        "args": ["${serverPath}"]`,
    '      }',
    '    }',
    '  }',
  ].join('\n');
  console.log('\n' + chalk.yellow('💡') + ' Add this to your Claude Desktop config manually:');
  console.log(chalk.gray(snippet));
}

/** Merge an `imap` MCP server entry into the Claude Desktop config. */
async function configureClaudeDesktop(): Promise<void> {
  const spinner = ora('Configuring Claude Desktop…').start();
  const serverPath = serverEntryPath();
  try {
    const configPath = claudeConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    const config = await readJsonConfig(configPath);
    config.mcpServers ??= {};
    config.mcpServers.imap = { command: 'node', args: [serverPath] };

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    spinner.succeed('Claude Desktop is configured.');
    console.log('\n' + chalk.green('✓') + ' Updated Claude Desktop configuration');
    console.log('  Config:  ' + chalk.cyan(configPath));
    console.log('  Server:  ' + chalk.cyan(serverPath));
    console.log('\n' + chalk.yellow('⚠') + '  ' + chalk.bold('Important:') + ' restart Claude Desktop to apply the change');
  } catch (error) {
    spinner.fail('Could not configure Claude Desktop');
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
    printManualSnippet(serverPath);
  }
}

/** Ask a yes/no question on the terminal; defaults to no. */
function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(chalk.cyan('? ') + question + ' (y/N): ', (answer) => {
      rl.close();
      resolve(/^y/i.test(answer.trim()));
    });
  });
}

/** Launch the local web UI and print next steps. */
async function launchWebUi(port: number, openBrowser: boolean): Promise<void> {
  const spinner = ora('Launching the web UI…').start();
  try {
    const server = new WebUIServer(port);
    await server.start(openBrowser);
    spinner.succeed('Web UI is up.');

    console.log('\n' + chalk.green('✓') + ' Setup wizard available at: ' + chalk.cyan(`http://localhost:${port}`));
    console.log('\n' + chalk.yellow('ℹ') + ' Stop the server with Ctrl+C\n');
    if (!openBrowser) {
      console.log(chalk.gray('  Open the URL above in your browser'));
    }

    console.log('\n' + chalk.blue('📧') + ' Once your accounts are configured:');
    console.log('  1. Restart Claude Desktop');
    console.log('  2. Ask Claude: "Show me my latest emails"');
    console.log('  3. Ask Claude: "Add a new email account"');
    console.log('  4. Ask Claude: "List all my email accounts"');
  } catch (error) {
    spinner.fail('Could not start the web UI');
    console.error(chalk.red('Error:'), error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log(chalk.blue.bold('\n🚀 IMAP MCP Server Setup Wizard\n'));

  const wantClaude =
    options.claudeSetup ||
    (!options.skipClaude && (await confirm('Do you want to setup Claude Desktop integration?')));
  if (wantClaude) {
    await configureClaudeDesktop();
    console.log('');
  }

  await launchWebUi(parseInt(options.port, 10), options.open);
}

main().catch(console.error);
