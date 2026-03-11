#!/usr/bin/env node
/**
 * Add cron job with session targeting
 *
 * Usage: node scripts/add-cron-session.js <sessionKey> <message> [cron-expr]
 *
 * Examples:
 *   node scripts/add-cron-session.js telegram "Check server status" "0 9 * * *"
 *   node scripts/add-cron-session.js lark "Daily report" "0 18 * * 1-5"
 */

import fs from 'node:fs';
import { loadSessionStore, resolveStorePath } from '../dist/config/sessions.js';
import { loadConfig } from '../dist/config/config.js';

const SESSIONS_FILE = '/home/hunglk/.clawdis/sessions/sessions.json';

function listSessions() {
  const store = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  console.log('Available Sessions:');
  console.log('===================');
  for (const [key, entry] of Object.entries(store)) {
    if (key === 'global' || key === 'unknown') continue;
    const channel = entry?.lastChannel || 'unknown';
    const lastTo = entry?.lastTo || '';
    const updated = new Date(entry?.updatedAt || 0).toLocaleString();
    console.log(`  ${key}: ${channel}${lastTo ? ` (${lastTo})` : ''}`);
    console.log(`    Updated: ${updated}`);
  }
}

function createCronJob(sessionKey, message, cronExpr, deliver = true) {
  const now = Date.now();
  const job = {
    name: `${sessionKey}-${Date.now()}`,
    description: `Target ${sessionKey} session: ${message.slice(0, 50)}`,
    enabled: true,
    schedule: cronExpr
      ? { kind: 'cron', expr: cronExpr, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }
      : { kind: 'at', atMs: now + 60000 }, // Default: run in 1 minute
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message,
      sessionKey,
      deliver,
      channel: sessionKey === 'telegram' ? 'telegram' : undefined,
      to: sessionKey === 'telegram' ? '5279113116' : undefined,
    }
  };

  // Save to temp file for manual addition
  const outputFile = `/tmp/cron-${sessionKey}-${Date.now()}.json`;
  fs.writeFileSync(outputFile, JSON.stringify(job, null, 2));
  console.log(`\n✅ Cron job created: ${outputFile}`);
  console.log(`\nTo add it, run:`);
  console.log(`  clawdis cron add < ${outputFile}`);
  console.log(`\nOr via WebSocket API:`);
  console.log(`  {"method":"cron.add","id":"test","params":${JSON.stringify(job)}}`);

  return outputFile;
}

// CLI
const args = process.argv.slice(2);
const command = args[0];

if (command === 'list' || command === 'ls') {
  listSessions();
} else if (command === 'add' && args.length >= 3) {
  const [_, sessionKey, message, cronExpr] = args;
  createCronJob(sessionKey, message, cronExpr);
} else {
  console.log(`
Usage: node scripts/add-cron-session.js <command> [args...]

Commands:
  list, ls          List available sessions
  add <key> <msg> [cron]   Add cron job targeting session

Examples:
  node scripts/add-cron-session.js list
  node scripts/add-cron-session.js add telegram "Check server" "0 9 * * *"
  node scripts/add-cron-session.js add lark "Daily report" "0 18 * * 1-5"
`);
  listSessions();
}
