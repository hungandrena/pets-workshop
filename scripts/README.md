# scripts

Framework-free helper scripts. Everything here runs with nothing but `bash`, so
the same command works on a developer machine and in CI.

| Script | Purpose |
| --- | --- |
| `verify.sh` | The CI check run by `.github/workflows/pr.yml` on every pull request. |
| `hello.sh` | Prints a greeting. Smallest possible end-to-end example. |

## verify.sh

```bash
bash scripts/verify.sh
```

Exits `0` when every check passes, `1` when any check fails. It runs:

1. `npm run lint --if-present` and `npm test --if-present`, but only if a root
   `package.json` exists. There is none today, so this step is skipped.
2. A smoke check of `scripts/hello.sh`: the script must exit `0` and print
   something to stdout.
3. A repo-wide guard that no tracked file contains the pipeline marker.

## hello.sh

```bash
./scripts/hello.sh
```

Committed with the executable bit set, so no explicit interpreter is needed.
