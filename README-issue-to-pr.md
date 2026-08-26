# Issue → Pull Request pipeline

A minimal but genuinely working automation loop: a GitHub issue becomes a green pull
request, and a human does the merge. The loop is enforced by Claude Code hooks rather than
by convention, so an agent cannot skip a step even if it wants to.

## The loop

```
  gh issue view <n>
        │
        ▼
  .llm/issue-<n>.md          ← requirements, committed on purpose
        │
        ▼
  feature/issue-<n>-<slug>   ← branch
        │
        ▼
  implement + commit + push
        │
        ▼
  gh pr create ──────────────► [PreToolUse gate] blocks unless .llm/issue-<n>.md exists
        │
        ▼
  PR opened ─────────────────► [PostToolUse] sees PR URL, records it, demands a CI watch
        │
        ▼
  ┌─────────────────────────┐
  │ [Stop hook]             │  pending → block: keep watching
  │ read CI conclusion      │  failed  → block: here are the logs, fix and push
  │                         │  fixed   → comment: the failure + the pushed diff
  │                         │  spent   → comment: handoff, a human takes over
  │                         │  green   → print handoff, allow stop
  └─────────┬───────────────┘
            │ red, attempt < 3
            └──────► fix ──► commit ──► push ──► (loop re-enters)
            │
            ▼ green
     HUMAN MERGES. The agent stops here.
```

## The artifacts and what each one enforces

| Artifact | Entry point | What it enforces |
|---|---|---|
| `.claude/hooks/gate-pr-create.js` | `PreToolUse` on `Bash` | No PR without requirements. Blocks any command containing `gh pr create` unless `.llm/issue-<n>.md` exists for the issue named by the branch. |
| `.claude/hooks/watch-pr-pipeline.js` | `PostToolUse` on `Bash` | The PR cannot be forgotten. Any Bash output containing a PR URL is recorded to `.claude/.pipeline-state.json` and the agent is told to run `gh pr checks <n> --watch`. |
| `.claude/hooks/pipeline-loop.js` | `Stop` | The agent cannot stop on a red or unknown build. Reads the CI verdict: pending → block, failed → block with the failing log tail (max 3 auto-fix attempts), green → print the handoff and allow the stop. Also writes the audit trail to the PR (see below). |
| `.claude/skills/issue-to-pr/SKILL.md` | `/issue-to-pr` | The happy path, as literal commands. Orchestration only — the hooks are the enforcement. |
| `.github/workflows/pr.yml` + `scripts/verify.sh` | GitHub Actions | A real, tiny, *failable* verdict for the loop to react to. |

Supporting details:

- `.claude/settings.json` wires the three hooks. The `Stop` entry has no `matcher` key —
  Stop hooks do not take one.
- `.claude/.pipeline-state.json` is gitignored per-session agent scratch: `{ pr, attempts,
  url, branch, noChecks, lastFailure, handoffPosted }`.
- `.llm/` is **not** gitignored. Those files are the requirements contract that CI and any
  reviewer can read.

## The audit trail on the PR

The terminal handoff dies with the session; a reviewer only ever sees the PR. So the Stop
hook writes two kinds of comment — and only these two, because everything else a comment
could say is already visible in the PR body or the checks widget.

**1. After each auto-fix — the failure paired with the diff that answered it.**

When CI is red the hook cannot yet know *how* the agent will fix it, so it records the
failure plus the current HEAD sha in `lastFailure` and posts nothing. On the next loop
re-entry, if HEAD has moved, it posts one comment containing the failing log tail *and*
`git log --oneline` + `git diff --stat` for exactly what was pushed in response, then
clears `lastFailure`. That pairing is the point: it is what shows a reviewer whether the
agent fixed the cause or quietly weakened `verify.sh`. If HEAD has not moved, nothing is
posted — there is nothing honest to report yet.

**2. On an exhausted auto-fix budget — the human handoff point.**

At attempt 3 the hook stops blocking and hands off. It posts the failing checks and log
tail as a comment first, so the moment a human is needed is recorded where the human is
actually looking. `handoffPosted` in the state file keeps a re-run from stacking
duplicates.

Both are best effort: `postComment` ignores its exit status, so a `gh` failure, a missing
token, or a repo with comments disabled changes nothing about the verdict. Reading review
comments is deliberately *not* part of this — that would turn the Stop hook into an open
poll on human input and break the rule that the pipeline ends at a green PR.

## Design properties

- **Node built-ins only.** No dependencies, no `npm install`, no `jq`.
- **Every hook fails open.** `main()` is wrapped in `.catch(() => process.exit(0))` and
  stdin is parsed defensively. A hook that crashes closed wedges the session, so a broken
  hook is designed to do nothing instead.
- **Comments never gate anything.** The two PR comments are an audit trail for the human,
  not a control channel. Nothing reads them back, and posting failures are swallowed.
- **Never merges.** Nothing in the hooks, the skill, the workflow, or `verify.sh` invokes
  `gh pr merge` or passes `--auto`. The only occurrences of those strings anywhere are the
  sentences forbidding them.
- **The loop is bounded.** Auto-fix attempts are capped at 3, tracked in state. On the 4th
  the hook hands off to a human instead of blocking again. A PR reporting no checks at all
  is also bounded (3 polls) so a repo without PR CI can never wedge the session.
- **Only acts on branches it owns.** Every hook no-ops unless the current branch matches
  `issue-(\d+)`, so unrelated work in the same repo is untouched.
- **Blocking channels differ by hook type.** Pre/PostToolUse block with
  `{"decision":"block","reason":"..."}` on stdout and exit 0. The Stop hook blocks with
  exit code 2 and the reason on stderr — that is the channel that feeds CI output back to
  the agent as actionable context.

## The seedable failure

`scripts/verify.sh` always runs one repo-agnostic guard: it fails if any tracked file
contains the marker `TODO(pipeline)`, printing the offending `file:line`. No toolchain,
deterministic, and trivial to plant and remove during a live demo.

The guard excludes the three paths that legitimately document the marker
(`scripts/verify.sh`, `README-issue-to-pr.md`, `.claude/`), so the docs describing it do
not fail CI forever.

## Demo this in five minutes

```bash
# 1. A throwaway issue.
gh issue create --title "Add a hello script" \
  --body "Add scripts/hello.sh that prints a greeting. Acceptance: running it exits 0."

# 2. Ask the agent to implement it.
#    /issue-to-pr 123     (or just: "implement issue 123")

# 3. Plant the seedable failure in the implementation, so CI goes red on the first run.
#    Add this line somewhere in the new code:
#      # TODO(pipeline) remove me
#    Commit and push it with the rest.

# 4. Watch the loop.
#    - The gate blocks `gh pr create` until .llm/issue-123.md exists.
#    - The PostToolUse hook records the PR and demands `gh pr checks 123 --watch`.
#    - CI goes red. The Stop hook refuses the stop and hands back the failing log tail.
#    - The agent removes the marker, commits, pushes. The loop re-enters.
#    - The Stop hook comments on the PR: the failure, and the diff that answered it.
#    - CI goes green. The Stop hook prints the handoff and allows the stop.

# 5. Confirm the stop point.
gh pr view 123          # open, green, NOT merged
```

Step 4 is the whole point: the red build is fed back as context, not as a dead end.

To reset between demo runs:

```bash
rm -f .claude/.pipeline-state.json
```

## Honest caveat

The hooks are deterministic. The agent's *response* to them is not.

A hook can reliably block a tool call, record a PR, or refuse a stop, and it can put
precise instructions in front of the model. It cannot guarantee the model reads them
carefully, fixes the right cause rather than the symptom, or resists weakening a check to
make it pass. The gate guarantees a requirements file exists — not that it is any good.
The 3-attempt cap exists because an agent that cannot fix a build in three tries will
usually not fix it in thirty.

Treat this as a mechanism that makes the right path the path of least resistance, and
review the PR anyway.
