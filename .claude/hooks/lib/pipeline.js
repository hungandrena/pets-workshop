'use strict';

/**
 * Shared pipeline plumbing for the issue-to-pr hooks.
 *
 * The audit trail is written from two different hooks — the Stop hook, and the
 * PostToolUse hook that sees `gh pr checks` output — because the Stop hook alone
 * only observes a red build the agent actually *stops* on. An agent that watches
 * CI, fixes and pushes inside a single turn never stops, so the Stop hook never
 * sees the failure. Keeping the logic here means the two entry points cannot
 * drift apart.
 *
 * Node built-ins only. Every function is best effort: callers must be able to
 * ignore a failure and carry on.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_ATTEMPTS = 3;
const LOG_TAIL_LINES = 30;

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** Run a command, capturing output and deliberately ignoring the exit status. */
function run(cmd, args, opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      cwd: projectDir(),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
    });
    return {
      status: r.status,
      stdout: String(r.stdout || ''),
      stderr: String(r.stderr || ''),
    };
  } catch {
    return { status: null, stdout: '', stderr: '' };
  }
}

function currentBranch() {
  const r = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : '';
}

/** The issue number this branch belongs to, or null when we do not own it. */
function issueOfBranch(branch) {
  const m = /issue-(\d+)/.exec(String(branch || ''));
  return m ? m[1] : null;
}

function headSha() {
  const r = run('git', ['rev-parse', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : '';
}

function stateFilePath() {
  return path.join(projectDir(), '.claude', '.pipeline-state.json');
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2) + '\n');
  } catch {
    /* best effort — never block on a write failure */
  }
}

/** Post a PR comment. Best effort — a failure here must never affect a verdict. */
function postComment(pr, body) {
  const r = run('gh', ['pr', 'comment', String(pr), '--body-file', '-'], { input: body });
  return r.status === 0;
}

/** Names of the failing checks in a plain `gh pr checks` table, if any. */
function failingChecksInText(text) {
  return String(text)
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((cols) => cols.length >= 2)
    .filter((cols) => /^(fail|failure|error)/i.test(String(cols[1] || '').trim()))
    .map((cols) => String(cols[0] || 'check').trim())
    .filter(Boolean);
}

/** Tail of the failing log for the most recent run on this branch. */
function failingLogTail(branch) {
  const list = run('gh', [
    'run', 'list', '--branch', branch, '--limit', '1',
    '--json', 'databaseId,workflowName,conclusion',
  ]);
  let runId = null;
  let workflowName = '';
  try {
    const parsed = JSON.parse(list.stdout.trim() || '[]');
    if (Array.isArray(parsed) && parsed[0]) {
      runId = parsed[0].databaseId;
      workflowName = String(parsed[0].workflowName || '');
    }
  } catch {
    runId = null;
  }
  if (!runId) return { workflowName, tail: '' };

  const log = run('gh', ['run', 'view', String(runId), '--log-failed']);
  const text = (log.stdout + '\n' + log.stderr).split('\n').filter((l) => l.trim());
  return { workflowName, tail: text.slice(-LOG_TAIL_LINES).join('\n') };
}

function logDetails(summary, tail) {
  if (!tail) return [];
  // Fence with ~~~ so a log line containing ``` cannot break out of the block.
  return ['', `<details><summary>${summary}</summary>`, '', '~~~', tail, '~~~', '', '</details>'];
}

/**
 * What the agent actually pushed in answer to a recorded failure.
 * Returns null when HEAD has not moved — nothing was done yet, so there is
 * nothing honest to report.
 */
function fixSince(sha) {
  if (!sha) return null;
  const head = headSha();
  if (!head || head === sha) return null;

  const log = run('git', ['log', '--oneline', '--no-decorate', `${sha}..HEAD`]);
  const stat = run('git', ['diff', '--stat', `${sha}..HEAD`]);
  if (log.status !== 0 || stat.status !== 0) {
    // Amended or rebased away — say so rather than report a bogus diff.
    return { head, rewritten: true, commits: '', stat: '' };
  }
  return { head, rewritten: false, commits: log.stdout.trim(), stat: stat.stdout.trim() };
}

/** Comment: the failure, paired with the change that answered it. */
function fixCommentBody(issue, failure, fix) {
  const failing = Array.isArray(failure.failing) ? failure.failing : [];
  // The attempt number is only known when the Stop hook recorded the failure;
  // the PostToolUse path sees the red build without owning the attempt budget.
  const heading = Number.isInteger(failure.attempt)
    ? `### 🔁 Auto-fix attempt ${failure.attempt}/${MAX_ATTEMPTS} — issue #${issue}`
    : `### 🔁 Auto-fix — issue #${issue}`;
  return [
    heading,
    '',
    `**CI failed:** ${failing.length ? failing.join(', ') : 'unknown'}`,
    failure.workflowName ? `**Workflow:** ${failure.workflowName}` : null,
    ...logDetails('Failing log tail', failure.tail),
    '',
    '**Pushed in response:**',
    '',
    ...(fix.rewritten
      ? [`History was rewritten; HEAD is now \`${fix.head.slice(0, 12)}\`. Compare manually.`]
      : ['~~~', fix.commits || '(no new commits)', '', fix.stat || '(no file changes)', '~~~']),
    '',
    '> Posted by the issue-to-pr hooks. Check that this addresses the cause rather',
    '> than weakening the check.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Comment: the auto-fix budget is gone, a human takes over here. */
function handoffCommentBody(issue, branch, pr, attempts, failing, workflowName, tail) {
  return [
    '### 🤝 Handoff — auto-fix budget exhausted',
    '',
    `CI is still red after ${attempts} auto-fix attempts. The agent has stopped and will`,
    'not try again. This needs a human.',
    '',
    `**Issue:** #${issue}`,
    `**Branch:** \`${branch}\``,
    `**Failing checks:** ${failing.length ? failing.join(', ') : 'unknown'}`,
    workflowName ? `**Workflow:** ${workflowName}` : null,
    ...logDetails('Failing log tail', tail),
    '',
    '~~~',
    `gh pr checks ${pr}`,
    'gh run view --log-failed',
    '~~~',
    '',
    '> Posted by the issue-to-pr hooks. Not merged — merging is the human’s decision.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Record a red build so the next push can be paired with it.
 * Never overwrites a failure that has not been reported yet: the first failure
 * is the one whose fix we are still waiting to see.
 */
function recordFailure(state, { attempt = null, failing, workflowName, tail }) {
  if (state.lastFailure) return state;
  return {
    ...state,
    lastFailure: { attempt, failing, workflowName, tail, headSha: headSha() },
  };
}

/**
 * Post the pairing comment if a failure is pending and HEAD has moved since.
 * Returns the state to persist; `posted` says whether a comment went out.
 */
function flushRecordedFailure(state, pr, issue) {
  const recorded = state && state.lastFailure;
  if (!recorded || typeof recorded !== 'object') return { state, posted: false };

  const fix = fixSince(String(recorded.headSha || ''));
  if (!fix) return { state, posted: false };

  postComment(pr, fixCommentBody(issue, recorded, fix));
  return { state: { ...state, lastFailure: null }, posted: true };
}

module.exports = {
  MAX_ATTEMPTS,
  LOG_TAIL_LINES,
  projectDir,
  run,
  currentBranch,
  issueOfBranch,
  headSha,
  stateFilePath,
  readState,
  writeState,
  postComment,
  failingChecksInText,
  failingLogTail,
  logDetails,
  fixSince,
  fixCommentBody,
  handoffCommentBody,
  recordFailure,
  flushRecordedFailure,
};
