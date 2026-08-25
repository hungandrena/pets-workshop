---
issue: 1
branch: feature/issue-1-add-hello-script
created: 2026-08-25
---

# #1: Add a hello script

## Description
The repository needs a small shell script at `scripts/hello.sh` that prints a
greeting when run. It sits alongside the existing `scripts/verify.sh` and needs
no toolchain beyond bash, so it can run in CI and on a developer machine
unchanged.

## Acceptance Criteria
- [ ] `scripts/hello.sh` exists in the repository.
- [ ] Running the script prints a greeting to stdout.
- [ ] Running the script exits with status 0.
- [ ] The file is committed with the executable bit set, so `./scripts/hello.sh`
      works without an explicit interpreter.
