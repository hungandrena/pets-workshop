#!/usr/bin/env node
'use strict';

/**
 * PostToolUse (Bash) — notices that a PR now exists, records it in
 * .claude/.pipeline-state.json, and demands a CI watch.
 *
 * Fires on ANY Bash output containing a PR URL (`gh pr view` included). That is
 * acceptable because it is idempotent — but it is exactly why an existing
 * `attempts` counter for the same PR must be preserved rather than reset.
 *
 * Fails open: any unexpected condition exits 0.
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

  const response = input.tool_response;
  const output = String(
    (response && typeof response === 'object' ? response.stdout : undefined) ??
      response ??
      ''
  );

  const match = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/.exec(output);
  if (!match) process.exit(0);

  const url = match[0];
  const pr = Number(match[1]);
  if (!Number.isInteger(pr) || pr <= 0) process.exit(0);

  const branch = currentBranch();
  if (!branch || !/issue-(\d+)/.test(branch)) process.exit(0); // not our branch

  const stateFile = path.join(projectDir(), '.claude', '.pipeline-state.json');

  // Preserve `attempts` when the state file already names this same PR, so that
  // a stray `gh pr view` cannot reset the auto-fix budget.
  let attempts = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (prev && Number(prev.pr) === pr && Number.isFinite(Number(prev.attempts))) {
      attempts = Number(prev.attempts);
    }
  } catch {
    attempts = 0;
  }

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ pr, attempts, url, branch }, null, 2) + '\n'
    );
  } catch {
    process.exit(0); // cannot persist state — do nothing rather than block
  }

  const reason = [
    `📌 Pull request #${pr} is open: ${url}`,
    '',
    'This PR is now tracked by the pipeline. Next step, do not skip it:',
    '',
    `  gh pr checks ${pr} --watch`,
    '',
    'Wait for a real CI verdict.',
    '  • Red  → read the failing logs, fix the cause, commit, push. The loop re-runs.',
    '  • Green → the Stop hook prints the handoff.',
    '',
    'Do not merge. Merging is the human’s decision.',
  ].join('\n');

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

main().catch(() => process.exit(0));
