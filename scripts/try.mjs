#!/usr/bin/env node
/**
 * Smoke-test the server without an MCP client.
 *
 *   npm run try -- "<figma url or file key>"
 *   npm run try -- "<figma url>" --raw          # full JSON, as the model sees it
 *   npm run try -- "<figma url>" --image <id>   # render a node, write it to disk
 *
 * Spawns dist/index.js and speaks real JSON-RPC to it, so this exercises the
 * actual transport rather than importing the functions directly.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'dist', 'index.js');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const raw = args.includes('--raw');
const imageIdx = args.indexOf('--image');
const imageId = imageIdx >= 0 ? args[imageIdx + 1] : null;

if (!file) {
  console.error('Usage: npm run try -- "<figma url or file key>" [--raw] [--image <node id>]');
  process.exit(1);
}

/** Env var wins; fall back to the Claude Desktop config so there's nothing to set up. */
function findToken() {
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN;
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json'), 'utf8')
    );
    return cfg?.mcpServers?.['figma-comments']?.env?.FIGMA_TOKEN;
  } catch {
    return undefined;
  }
}

const token = findToken();
if (!token) {
  console.error('No token. Set FIGMA_TOKEN, or configure the server in Claude Desktop first.');
  process.exit(1);
}

const proc = spawn('node', [SERVER], {
  env: { ...process.env, FIGMA_TOKEN: token },
  stdio: ['pipe', 'pipe', 'inherit']
});

let buffer = '';
const pending = new Map();
proc.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* not a JSON-RPC frame */
    }
  }
});

let nextId = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

await call('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'try', version: '1' }
});
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

if (imageId) {
  const res = await call('tools/call', {
    name: 'get_figma_comment_image',
    arguments: { file, node_id: imageId }
  });
  if (res.result.isError) {
    console.error(res.result.content[0].text);
    proc.kill();
    process.exit(1);
  }
  const img = res.result.content.find((c) => c.type === 'image');
  const out = `figma-${imageId.replace(/\W/g, '-')}.png`;
  writeFileSync(out, Buffer.from(img.data, 'base64'));
  console.log(res.result.content[0].text);
  console.log(`\nWrote ${out} (${Math.round(img.data.length * 0.75 / 1024)}KB)`);
  proc.kill();
  process.exit(0);
}

const res = await call('tools/call', {
  name: 'list_figma_comments',
  arguments: {
    file,
    include_resolved: true,
    // A frame URL scopes itself; --all overrides that the way the model would.
    ...(args.includes('--all') ? { scope: 'file' } : {})
  }
});

if (res.result.isError) {
  console.error(res.result.content[0].text);
  proc.kill();
  process.exit(1);
}

// The tool now returns the readable form directly — there is nothing left for
// this script to pretty-print. `--raw` is kept so the flag still works, but
// both paths print the same thing, which is the point.
const body = res.result.content[0].text;
console.log(`\n${body}\n`);
if (raw) console.log(`[${body.length} chars]`);

proc.kill();
