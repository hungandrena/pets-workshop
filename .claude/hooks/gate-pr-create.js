#!/usr/bin/env node
'use strict';

/**
 * PreToolUse (Bash) — blocks `gh pr create` until requirements have been captured
 * in .llm/issue-<n>.md.
 *
 * Fails open: any unexpected condition exits 0 and lets the tool call through.
 * Only acts on branches this pipeline owns (name contains `issue-<digits>`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function currentBranch() {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectDir(),
      encoding: 'utf8',
    });
    if (r.status !== 0) return '';
    return String(r.stdout || '').trim();
  } catch {
    return '';
  }
}

async function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    process.exit(0);
  }
  if (!input || typeof input !== 'object') process.exit(0);

  if (input.tool_name !== 'Bash') process.exit(0);

  const command = String(input.tool_input?.command ?? '');
  if (!command.includes('gh pr create')) process.exit(0);

  const branch = currentBranch();
  if (!branch) process.exit(0);

  const match = /issue-(\d+)/.exec(branch);
  if (!match) process.exit(0); // not our branch — never interfere with hand-made PRs
  const n = match[1];

  const contextFile = path.join(projectDir(), '.llm', `issue-${n}.md`);
  try {
    if (fs.existsSync(contextFile)) process.exit(0); // requirements captured — PR allowed
  } catch {
    process.exit(0);
  }

  const reason = [
    `⛔ No requirements context for issue #${n}.`,
    '',
    'Before opening a PR:',
    `1. gh issue view ${n} --json title,body`,
    `2. Write .llm/issue-${n}.md (see the issue-to-pr skill for the format).`,
    '3. Commit it — it is part of the deliverable, not a scratch file.',
    '4. Retry `gh pr create`.',
    '',
    `Current branch: ${branch}`,
  ].join('\n');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

main().catch(() => process.exit(0));
