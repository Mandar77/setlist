---
name: autopilot
description: Run the Setlist task ledger unattended until every remaining task is done, blocked, or waiting on a date. Only when the user types /autopilot.
disable-model-invocation: true
---

Follow docs/plan/AUTOPILOT.md section 2 exactly. In short:

1. Sync develop. Read docs/plan/STATE.md, docs/plan/TASKS.yaml and any new ADRs. Unblock tasks whose human-needed issue is closed.
2. Take the first todo task whose deps are all done and whose not_before date has passed. Branch task/<id>-<slug>.
3. Write tests first from done_when, then code. Decide design questions yourself and record an ADR (section 2.3). Don't ask me.
4. Run make verify plus the task's verify until green; never weaken a gate. Run the reviewer subagent and fix its blocking findings.
5. Commit with the ledger update and push the branch. Poll CI in short calls while you start independent work. When green, fast-forward develop and push it.
6. If a stop rule applies (section 2.4), open a human-needed issue assigned to @me with exact steps and no identifiers or secrets, mark the task blocked, and continue.
7. When a milestone's tasks are done, run make gate M=<id> and write docs/reports/<id>.md. For M0, M4, M7 and M8, open the develop -> main release pull request and a human-needed issue asking me to merge.
8. Keep STATE.md to one screen. When nothing is selectable, comment a summary on the pinned "Autopilot log" issue and stop.
