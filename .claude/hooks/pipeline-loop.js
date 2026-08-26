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
 * This hook owns the auto-fix budget and the handoff. It shares the audit trail
 * with the PostToolUse hook, which catches the red builds this one never sees:
 * an agent that watches CI, fixes and pushes inside a single turn never stops.
 * Both write through lib/pipeline.js so the two paths cannot drift apart.
 *
 * Never merges. Fails open: any unexpected condition exits 0.
 * Only acts on branches this pipeline owns (name contains `issue-<digits>`).
 */

const fs = require('node:fs');
const {
  MAX_ATTEMPTS,
  LOG_TAIL_LINES,
  run,
  currentBranch,
  issueOfBranch,
  readState,
  writeState,
  postComment,
  failingLogTail,
  handoffCommentBody,
  recordFailure,
  flushRecordedFailure,
} = require('./lib/pipeline.js');

const MAX_NO_CHECK_POLLS = 3;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
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
  const structured = run('gh', ['pr', 'checks', String(pr), '--json', 'name,state,bucket']);
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
  const issue = issueOfBranch(branch);
  if (!issue) process.exit(0); // not our branch

  let state = readState();
  const pr = Number(state?.pr);
  if (!Number.isInteger(pr) || pr <= 0) process.exit(0);

  let attempts = Number.isFinite(Number(state.attempts)) ? Number(state.attempts) : 0;
  let noChecks = Number.isFinite(Number(state.noChecks)) ? Number(state.noChecks) : 0;

  // ── Audit trail: pair a recorded failure with the fix that answered it ──────
  // Deliberately before the new verdict is read, so it fires on the first
  // re-entry after a push, whatever that new verdict turns out to be.
  const flushed = flushRecordedFailure(state, pr, issue);
  if (flushed.posted) {
    state = flushed.state;
    writeState({ ...state, pr, attempts, noChecks });
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
      ...recordFailure(state, { attempt: attempts, failing, workflowName, tail }),
      pr,
      attempts,
      noChecks: 0,
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
        ? summary.split('\n').map((l) => `  ${l}`).join('\n')
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
