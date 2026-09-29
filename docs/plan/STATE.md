# Autopilot state

Milestone: M0 | Last done: — (bootstrap only) | Next: M0A-01 | Blocked: 30 tasks, M0B-* + M1-02/03 on H1

Metrics: coverage 95% (oracle-py, Python) | text F1 1.00 precision / 1.00 recall on the 8 hand-written cases | free-tier max — (estimator not built) | quarantined tests 0

Notes:
- Bootstrap (AUTOPILOT §4) complete. No task is `done` yet: the pre-plan M0 commit is
  groundwork feeding M0A-01/05/08 and CORE-01, not any task's full `done_when`.
- The GitHub remote already exists and is public and empty (`Mandar77/setlist`), and
  `gh` is authenticated with `repo`+`workflow`. Session 1 adopts it rather than creating it.
- PRD and PED are not in the repo; amendments are staged in `docs/spec-amendments.md`.
- Nothing is pushed yet — no remote branches exist. Per AUTOPILOT §2.1 step 8, work
  fast-forwards `develop` locally until Session 1, then everything pushes at once.
