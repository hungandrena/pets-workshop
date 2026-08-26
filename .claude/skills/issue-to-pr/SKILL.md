---
name: issue-to-pr
description: Take a GitHub issue from requirements to a green pull request. Use when asked to implement an issue, e.g. "implement issue 42".
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
user-invocable: true
---

# Issue → Pull Request

Follow these steps in order. Hooks enforce steps 7 and 8; the rest is on you.

1. **Read the issue.**
   `gh issue view <n> --json title,body,labels`

2. **Write the requirements contract** to `.llm/issue-<n>.md`. Capture **what** is
   required, never **how**:

   ```markdown
   ---
   issue: 42
   branch: feature/issue-42-<slug>
   created: <ISO date>
   ---

   # #42: <issue title>

   ## Description
   Two or three sentences, in your own words.

   ## Acceptance Criteria
   - [ ] One checkbox per verifiable outcome
   ```

   If the issue body has no acceptance criteria, derive them and say so in the PR
   description.

3. **Branch.**
   `git checkout -b feature/issue-<n>-<kebab-slug>` (keep the branch under 60 chars).

4. **Implement**, following any conventions already documented in this repository.

5. **Commit** `.llm/issue-<n>.md` together with the first implementation commit — it is
   part of the deliverable, not a scratch file.

6. **Push.**
   `git push -u origin HEAD`

7. **Open the PR.**
   `gh pr create --title "#<n>: <issue title>" --body "..."` with `Closes #<n>` in the
   body. The gate hook fires here; if it blocks, do exactly what its message says.

8. **Hand control to the hooks.** Watch CI with `gh pr checks <n> --watch`, fix what it
   reports, commit, push. Do not decide for yourself that the pipeline is finished — the
   Stop hook decides.

**Never merge.** No `gh pr merge`, no `--auto`. The pipeline ends at a green PR; merging
is the human's decision.
