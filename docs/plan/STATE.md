# Autopilot state

Milestone: M2 | Last done: M0A-11 | Next: **8 selectable** — M2-05a (ML Kit collector), M2-02, HYG-08/09, M1-04, M1-05, M5-01, CORE-04b | Blocked: 36, nearly all on H1

Metrics: coverage 96.0% stmts / 90.7% branches (`packages/core`) | Stryker 55.4%, an [ADR-010](../adr/0010-mutation-floor-ratchet.md) ratchet | extraction F1 0.985 clean | **OCR: Tesseract.js song-F1 0.273 overall — 0.425 screenshot, 0.343 print, 0.079 handwriting** | free-tier worst row 69.2% prod CloudFront, Lambda 63.7%, gate 70% | `make verify` ~110s

Notes:

- **The first OCR numbers exist** ([reports/ocr-eval.md](../reports/ocr-eval.md), M2-05a).
  [ADR-015](../adr/0015-ocr-engine-decision-rule.md) fires: handwriting F1 0.079 against a
  0.78 floor, so **handwriting scans default to the server engine**, re-checked at M2-07
  against the real set. The rule was written before any engine ran, which is the only
  reason it means anything. **ML Kit is the remaining collector**; Apple Vision is deferred
  to M2-08 behind the Apple Developer Program.
- **The fallback rate is measured, and it went UP, not down.** Confidence fallback
  (FR-M-006) is 13.39% — below the assumed 20% — but ADR-015's routing sends all
  handwriting to the server regardless, so the effective rate is 37%. `make estimate`
  still exits 0: prod Lambda 63.7%, CloudFront 69.2%, both now *watch* rather than
  comfortable.
- **[ADR-013](../adr/0013-dynamodb-fixed-capacity.md) is applied** (M0A-11): fixed DynamoDB
  capacity, Application Auto Scaling banned in all four places, alarms counted with
  `DescribeAlarms`. It found the **seventh instrument reporting success while doing
  nothing**, and the first inside a gate rather than in front of one — `never-use.test.ts`'s
  capacity assertion had looped over an empty set for two months.
- **[ADR-014](../adr/0014-ocr-metrics-oracle.md)'s jiwer oracle paid for itself on its first
  run**, finding three divergences; two would have shipped. jiwer's default word splitter
  ignores newlines, so an engine that merged every line would have been *rewarded*.
- **`protect-develop` enforces 15 required checks; the script defines 18**
  ([issue #20](https://github.com/Mandar77/setlist/issues/20)). The emulator and OCR jobs
  gate nothing until `github-setup.sh` is re-run. Long-form history:
  [reports/journal.md](../reports/journal.md).
