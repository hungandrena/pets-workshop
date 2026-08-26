#!/usr/bin/env node
'use strict';

/**
 * Stop hook — the heart of the pipeline. Turns a one-shot PR into a loop.
 *
 *   pending → block (exit 2, reason on stderr): keep watching
 *   failed  → block (exit 2, reason on stderr) with the failing logs, up to 3 attempts
 *   green   → print the handoff on stdout and allow the stop (exit 0)
 *
 * For a Stop hook, blocking is exit code 2 with the reason on stderr — that is the
 * channel that feeds CI output back to the agent as actionable context.
 *
 * It also leaves an audit trail on the PR itself, because the terminal handoff dies
 * with the session while a reviewer only ever sees the PR:
 *
 *   - after each auto-fix, one comment pairing the failure with the diff that answered it
 *   - on an exhausted auto-fix budget, one comment marking the human handoff point
 *
 * Commenting is best effort and never affects the verdict.
 *
 * Never merges. Fails open: any unexpected condition exits 0.
 * Only acts on branches this pipeline owns (name contains `issue-<digits>`).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_ATTEMPTS = 3;
const MAX_NO_CHECK_POLLS = 3;
const LOG_TAIL_LINES = 30;

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
  if (r.status !== 0) return '';
  return r.stdout.trim();
}

function stateFilePath() {
  return path.join(projectDir(), '.claude', '.pipeline-state.json');
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
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

function bucketOf(check) {
  return String(check?.bucket ?? check?.state ?? '').toLowerCase();
}

/** Classify the structured `gh pr checks --json` payload. */
function classify(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return { verdict: 'none', failing: [], pending: [] };
  }
  const name = (c) => String(c?.name || 'check');
  const pending = checks.filter((c) => bucketOf(c).startsWith('pending')).map(name);
  const failing = checks
    .filter((c) => {
      const b = bucketOf(c);
      return b.startsWith('fail') || b === 'failure' || b === 'error';
    })
    .map(name);

  if (pending.length) return { verdict: 'pending', failing, pending };
  if (failing.length) return { verdict: 'failed', failing, pending: [] };
  return { verdict: 'green', failing: [], pending: [] };
}

/** Fallback: classify the plain-text `gh pr checks` table (name<TAB>status<TAB>...). */
function classifyPlain(text) {
  const rows = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter((cols) => cols.length >= 2);

  if (!rows.length) return { verdict: 'none', failing: [], pending: [] };

  const status = (cols) => String(cols[1] || '').toLowerCase();
  const pending = rows.filter((c) => status(c).startsWith('pending')).map((c) => c[0]);
  const failing = rows
    .filter((c) => status(c).startsWith('fail') || status(c) === 'error')
    .map((c) => c[0]);

  if (pending.length) return { verdict: 'pending', failing, pending };
  if (failing.length) return { verdict: 'failed', failing, pending: [] };
  return { verdict: 'green', failing: [], pending: [] };
}

function ciVerdict(pr) {
  // `gh pr checks` exits non-zero when checks are pending (8) or failing (1),
  // so capture the output and ignore the exit status.
  const structured = run('gh', [
    'pr',
    'checks',
    String(pr),
    '--json',
    'name,state,bucket',
  ]);
  const out = structured.stdout.trim();
  if (out) {
    try {
      const parsed = JSON.parse(out);
      if (Array.isArray(parsed)) return classify(parsed);
    } catch {
      /* fall through to the plain-text form */
    }
  }
  const plain = run('gh', ['pr', 'checks', String(pr)]);
  return classifyPlain(plain.stdout);
}

/** Tail of the failing log for the most recent run on this branch. */
function failingLogTail(branch) {
  const list = run('gh', [
    'run',
    'list',
    '--branch',
    branch,
    '--limit',
    '1',
    '--json',
    'databaseId,workflowName,conclusion',
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
  const tail = text.slice(-LOG_TAIL_LINES).join('\n');
  return { workflowName, tail };
}

function prMeta(pr, fallbackUrl) {
  const r = run('gh', ['pr', 'view', String(pr), '--json', 'number,url,title,body']);
  try {
    const parsed = JSON.parse(r.stdout.trim() || '{}');
    return {
      url: String(parsed.url || fallbackUrl || ''),
      title: String(parsed.title || ''),
      body: String(parsed.body || ''),
    };
  } catch {
    return { url: String(fallbackUrl || ''), title: '', body: '' };
  }
}

function headSha() {
  const r = run('git', ['rev-parse', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : '';
}

/** Post a PR comment. Best effort — a failure here must never affect the loop. */
function postComment(pr, body) {
  const r = run('gh', ['pr', 'comment', String(pr), '--body-file', '-'], { input: body });
  return r.status === 0;
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

/** Comment #1: the failure, paired with the change that answered it. */
function fixCommentBody(issue, failure, fix) {
  const failing = Array.isArray(failure.failing) ? failure.failing : [];
  return [
    `### 🔁 Auto-fix attempt ${failure.attempt}/${MAX_ATTEMPTS} — issue #${issue}`,
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
    '> Posted by the issue-to-pr Stop hook. Check that this addresses the cause rather',
    '> than weakening the check.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Comment #2: the auto-fix budget is gone, a human takes over here. */
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
    '> Posted by the issue-to-pr Stop hook. Not merged — merging is the human’s decision.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function block(reason) {
  process.stderr.write(reason + '\n');
  process.exit(2);
}

function allow(message) {
  if (message) process.stdout.write(message + '\n');
  process.exit(0);
}

async function main() {
  let input;
  try {
    input = JSON.parse(readStdin());
  } catch {
    process.exit(0);
  }
  if (!input || typeof input !== 'object') process.exit(0);

  // Without this guard the hook re-triggers itself forever.
  if (input.stop_hook_active) process.exit(0);

  const branch = currentBranch();
  if (!branch) process.exit(0);
  const branchMatch = /issue-(\d+)/.exec(branch);
  if (!branchMatch) process.exit(0); // not our branch
  const issue = branchMatch[1];

  const state = readState();
  const pr = Number(state?.pr);
  if (!Number.isInteger(pr) || pr <= 0) process.exit(0);

  let attempts = Number.isFinite(Number(state.attempts)) ? Number(state.attempts) : 0;
  let noChecks = Number.isFinite(Number(state.noChecks)) ? Number(state.noChecks) : 0;

  // ── Audit trail: pair the previous failure with the fix that answered it ─────
  // Deliberately before the new verdict is classified, so it fires on the first
  // re-entry after the agent pushed, whatever that new verdict turns out to be.
  const recorded = state.lastFailure;
  if (recorded && typeof recorded === 'object') {
    const fix = fixSince(String(recorded.headSha || ''));
    if (fix) {
      postComment(pr, fixCommentBody(issue, recorded, fix));
      state.lastFailure = null;
      writeState({ ...state, pr, attempts, noChecks });
    }
  }

  const { verdict, failing, pending } = ciVerdict(pr);

  // ── No checks reported at all ────────────────────────────────────────────────
  // Bounded, so a repo with no PR CI can never wedge the session.
  if (verdict === 'none') {
    noChecks += 1;
    writeState({ ...state, pr, attempts, noChecks });
    if (noChecks >= MAX_NO_CHECK_POLLS) {
      return allow(
        [
          `🤝 Handoff — PR #${pr} (issue #${issue})`,
          '',
          `No CI checks were reported after ${noChecks} polls. Either the workflow has not`,
          'registered yet, or this repository runs no checks on pull requests.',
          '',
          'A human needs to confirm the PR state manually:',
          `  gh pr view ${pr} --web`,
          '',
          'Do not merge. Merging is the human’s decision. Stopping here.',
        ].join('\n')
      );
    }
    return block(
      [
        `⏳ No CI verdict yet for PR #${pr} (poll ${noChecks}/${MAX_NO_CHECK_POLLS}).`,
        '',
        'Checks have not registered. Wait for a real verdict:',
        '',
        `  gh pr checks ${pr} --watch`,
        '',
        'Do not stop until CI has reported.',
      ].join('\n')
    );
  }

  // ── Pending ──────────────────────────────────────────────────────────────────
  if (verdict === 'pending') {
    writeState({ ...state, pr, attempts, noChecks: 0 });
    return block(
      [
        `⏳ CI is still running on PR #${pr} (issue #${issue}).`,
        '',
        pending.length ? `Pending: ${pending.join(', ')}` : null,
        '',
        'Wait for a verdict before stopping:',
        '',
        `  gh pr checks ${pr} --watch`,
        '',
        'When it returns, the loop re-runs and reads the conclusion.',
      ]
        .filter((l) => l !== null)
        .join('\n')
    );
  }

  // ── Failed ───────────────────────────────────────────────────────────────────
  if (verdict === 'failed') {
    attempts += 1;
    const { workflowName, tail } = failingLogTail(branch);

    if (attempts >= MAX_ATTEMPTS) {
      const meta = prMeta(pr, state.url);
      // `handoffPosted` keeps a re-run from stacking duplicate handoff comments.
      if (!state.handoffPosted) {
        postComment(
          pr,
          handoffCommentBody(issue, branch, pr, attempts, failing, workflowName, tail)
        );
      }
      writeState({
        ...state,
        pr,
        attempts,
        noChecks: 0,
        lastFailure: null,
        handoffPosted: true,
      });
      return allow(
        [
          `🤝 Handoff — CI is still red after ${attempts} auto-fix attempts.`,
          '',
          `PR #${pr}${meta.url ? `: ${meta.url}` : ''}`,
          `Issue: #${issue}`,
          `Branch: ${branch}`,
          `Failing checks: ${failing.length ? failing.join(', ') : 'unknown'}`,
          '',
          'The auto-fix budget is exhausted, so the loop stops blocking here on purpose.',
          'A human needs to look at this — the failure is likely something the agent',
          'cannot resolve from the logs alone.',
          '',
          `  gh pr checks ${pr}`,
          `  gh run view --log-failed`,
          '',
          'Do not merge. Merging is the human’s decision. Stopping here.',
        ].join('\n')
      );
    }

    writeState({
      ...state,
      pr,
      attempts,
      noChecks: 0,
      lastFailure: { attempt: attempts, failing, workflowName, tail, headSha: headSha() },
    });
    return block(
      [
        `❌ CI failed on PR #${pr} (issue #${issue}). Auto-fix attempt ${attempts}/${MAX_ATTEMPTS}.`,
        '',
        `Failing checks: ${failing.length ? failing.join(', ') : 'unknown'}`,
        workflowName ? `Workflow: ${workflowName}` : null,
        '',
        tail
          ? `Tail of the failing log (last ${LOG_TAIL_LINES} lines):\n\n${tail}`
          : 'No failing log could be retrieved. Inspect it yourself:\n  gh run view --log-failed',
        '',
        'Now do this:',
        '1. Fix the actual cause — not the symptom, and do not weaken the check.',
        '2. Commit the fix.',
        '3. git push',
        '4. Let this loop re-run and read the new verdict.',
        '',
        'Do not merge.',
      ]
        .filter((l) => l !== null)
        .join('\n')
    );
  }

  // ── Green ────────────────────────────────────────────────────────────────────
  writeState({ ...state, pr, attempts: 0, noChecks: 0 });
  const meta = prMeta(pr, state.url);
  const summary = meta.body.trim();

  return allow(
    [
      `✅ Handoff — PR #${pr} is green.`,
      '',
      meta.title ? `Title: ${meta.title}` : null,
      meta.url ? `URL:   ${meta.url}` : null,
      `Issue: #${issue}`,
      `Branch: ${branch}`,
      'All checks are passing.',
      '',
      'What was implemented:',
      summary
        ? summary
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n')
        : '  (The PR description is empty — write one paragraph summarising the change.)',
      '',
      'Anything unresolved:',
      `  Re-read .llm/issue-${issue}.md and state any acceptance criterion you derived`,
      '  yourself, any assumption you made, and anything you were unsure about.',
      '',
      'Cleanup, once the reviewer has read the requirements contract:',
      `  git rm .llm/issue-${issue}.md`,
      '',
      'Merging is the human’s decision. Do not merge. Stop here.',
    ]
      .filter((l) => l !== null)
      .join('\n')
  );
}

main().catch(() => process.exit(0));
