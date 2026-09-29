# Documentation

| File | Purpose |
| --- | --- |
| `PRD.md` | Base product requirements (v1.0, 2026-09-23) — **to be added** |
| `PED.md` | Zero-budget + mobile expansion (v1.0, 2026-09-28) — **to be added** |
| `hitl.md` | Human-in-the-loop checkpoints; several have long external lead times |
| `adr/` | Architecture decision records |

The two specs are currently held outside the repo. Drop them in here so `CLAUDE.md`'s
references resolve and so the gates have something to cite. **Where the PRD and PED
disagree, the PED wins** — it re-selects the AWS service set to hit a hard $0 bill.

## Open questions carried from the specs

These are recorded so they are not lost; see `adr/` as each is answered.

1. Does the owner hold Spotify Premium? (Gates the Spotify adapter entirely.)
2. Is the AWS account new (post-2025-07-15, credits) or legacy (perpetual free tier)?
3. Are sub-cent S3 charges invoiced once credits run out?
4. Is Google verification required for the `youtube` scope, and how long does it take?
5. Is published handwriting OCR accuracy representative of our golden set? (Measure at M2.)
6. Should dev move to a second Region for more DynamoDB headroom?
7. Will Checkmarx offer a trial or OSS licence?
8. Is the MusicBrainz 1 req/s limit still current?
