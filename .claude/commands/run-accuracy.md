---
description: Run the golden-set extraction accuracy gate and report precision/recall/F1
---

Run `make test-accuracy` and report the aggregate precision, recall and F1 against the
thresholds in `tests/accuracy/test_extraction_accuracy.py`.

If any case fails:
1. Show the specific spurious and missed songs, not just the aggregate.
2. Diagnose whether it is a parser bug or a wrong golden expectation.
3. Fix the parser — never loosen a threshold or edit an expectation to make the gate
   pass. If the expectation really is wrong, say so explicitly and explain why.
