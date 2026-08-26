---
issue: 5
branch: feature/issue-5-filter-dogs-by-status-and-breed
created: 2026-08-26
---

# #5: Filter the dog list by status and breed

## Description
`GET /api/dogs` returns every dog in the shelter and leaves any narrowing to the
client, which therefore has to fetch the whole table to show one subset of it.
The endpoint gains two optional query parameters, `status` and `breed`, so the
filtering happens where the data is. Because the repository runs no Python in CI
today, the same change also has to make the existing unit tests a real part of
the build — otherwise a broken endpoint would pass unnoticed.

## Acceptance Criteria
- [ ] `GET /api/dogs?status=AVAILABLE` returns only dogs with that adoption
      status, accepting the three values defined in `AdoptionStatus`.
- [ ] Status matching is case-insensitive: `available`, `Available` and
      `AVAILABLE` behave identically.
- [ ] An unrecognised status value returns HTTP 400 with a JSON error message —
      not 500, and not silently ignored.
- [ ] `GET /api/dogs?breed=Labrador` returns only dogs whose breed name matches,
      case-insensitively.
- [ ] Passing both parameters combines them with AND: a dog must match the
      status and the breed to appear.
- [ ] `total` and `total_pages` describe the filtered result set, so paging
      through a filtered list terminates correctly.
- [ ] A request with neither parameter returns what it returns today: same
      response shape, same defaults, same ordering.
- [ ] `app/server/test_app.py` covers each criterion above, including the 400
      case and the filtered-pagination case.
- [ ] `scripts/verify.sh` runs the Python unit tests and fails the build when
      they fail.
- [ ] `.github/workflows/pr.yml` provides what those tests need, so the check is
      really executed rather than skipped.

## Out of Scope
- Front-end changes in `app/client`.
- Free-text search, sorting, or any filter beyond the two named above.
