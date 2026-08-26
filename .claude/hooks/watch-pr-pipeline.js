#!/usr/bin/env node
'use strict';

/**
 * PostToolUse (Bash) — keeps the PR tracked, and owns the half of the audit
 * trail the Stop hook cannot see.
 *
 * Three jobs, in this order:
 *
 *   1. Flush: if a red build was recorded earlier and HEAD has moved since,
 *      comment on the PR pairing that failure with the diff that answered it.
 *   2. Record: if this Bash output is a `gh pr checks` table reporting a
 *      failure, remember it (plus the current HEAD) so step 1 can pair it later.
 *   3. Track: if this Bash output contains a PR URL, record the PR and demand a
 *      CI watch.
 *
 * Step 1 exists because the Stop hook only observes a build the agent actually
 * stops on. An agent that watches CI, fixes and pushes within a single turn
 * never stops, so the Stop hook never sees the red build at all and the trail
 * would silently stay empty.
 *
 * Fails open: any unexpected condition exits 0.
 * Only acts on branches this pipeline owns (name contains `issue-<digits>`).
 */

const {
  currentBranch,
  issueOfBranch,
  readState,
  writeState,
  failingChecksInText,
  failingLogTail,
  recordFailure,
  flushRecordedFailure,
} = require('./lib/pipeline.js');

const fs = require('node:fs');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
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

  const branch = currentBranch();
  const issue = issueOfBranch(branch);
  if (!issue) process.exit(0); // not our branch

  const response = input.tool_response;
  const output = String(
    (response && typeof response === 'object' ? response.stdout : undefined) ??
      response ??
      ''
  );

  let state = readState() || {};
  let pr = Number(state.pr);
  let dirty = false;

  // ── 1. Flush a recorded failure once the answer to it has been pushed ───────
  if (Number.isInteger(pr) && pr > 0) {
    const flushed = flushRecordedFailure(state, pr, issue);
    if (flushed.posted) {
      state = flushed.state;
      dirty = true;
    }
  }

  // ── 2. Record a red verdict seen in this command's output ───────────────────
  // Only the checks table is inspected, so the expensive log fetch happens at
  // most once per red build rather than on every Bash call.
  if (Number.isInteger(pr) && pr > 0 && !state.lastFailure) {
    const failing = failingChecksInText(output);
    if (failing.length) {
      const { workflowName, tail } = failingLogTail(branch);
      state = recordFailure(state, { failing, workflowName, tail });
      dirty = true;
    }
  }

  // ── 3. Track the PR itself ─────────────────────────────────────────────────
  const match = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/.exec(output);
  let reason = null;
  if (match) {
    const seen = Number(match[1]);
    if (Number.isInteger(seen) && seen > 0) {
      const url = match[0];
      // A different PR means a fresh budget and a stale trail; the same PR must
      // keep both, or any `gh pr view` would reset the loop.
      if (seen !== pr) {
        state = { ...state, attempts: 0, lastFailure: null, handoffPosted: false };
      }
      pr = seen;
      state = { ...state, pr, url, branch };
      dirty = true;

      reason = [
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
    }
  }

  if (dirty) writeState(state);
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

main().catch(() => process.exit(0));
