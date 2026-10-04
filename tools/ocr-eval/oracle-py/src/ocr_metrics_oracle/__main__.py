"""`python -m ocr_metrics_oracle`."""

from __future__ import annotations

import sys

from .metrics import main

raise SystemExit(main(sys.argv))
