#!/usr/bin/env bash
# Drive every Maestro flow in ONE invocation, retrying only a dead device driver.
#
# Two things, and the second is the one that needs explaining.
#
# ## One invocation
#
# The job used to run `maestro test` once per flow file. Each invocation starts its own
# on-device driver session over an adb-forwarded gRPC port, and on 2026-10-04 the second
# one died three seconds in, before its flow's first command:
#
#   maestro.android.DeviceServerDiedException: Device server died during 'deviceInfo'
#   Caused by: java.io.IOException: Command failed (tcp:39213): closed
#
# Same commit, green on the task branch, red on develop. Pointing Maestro at the directory
# runs every flow under one driver session, so there is no second session to lose.
#
# ## The retry is narrow, and loud
#
# A blanket retry would turn a real regression into an intermittent one, which is worse
# than a red build: the next person sees a flake where there is a defect. So this retries
# ONLY on `DeviceServerDiedException` — the driver channel dying, which is infrastructure
# — and never on a flow that ran and failed an assertion. An assertion failure is a
# result, and results are not retried.
#
# Every outcome is annotated. A run that needed a retry says so in the job summary, so a
# driver that starts dying often is visible rather than absorbed.
set -euo pipefail

FLOW_DIR="${1:-mobile/.maestro}"
MAX_ATTEMPTS="${MAESTRO_MAX_ATTEMPTS:-2}"
LOG="${RUNNER_TEMP:-/tmp}/maestro-run.log"

# The signature to retry on. Kept as one grep pattern so there is exactly one place to
# add another infrastructure fault, and so that adding one is a visible diff.
INFRA_FAULT='DeviceServerDiedException'

attempt=1
while true; do
  echo "::group::maestro test ${FLOW_DIR} (attempt ${attempt} of ${MAX_ATTEMPTS})"
  status=0
  maestro test "${FLOW_DIR}" 2>&1 | tee "${LOG}" || status="${PIPESTATUS[0]}"
  echo "::endgroup::"

  if [ "${status}" -eq 0 ]; then
    if [ "${attempt}" -gt 1 ]; then
      echo "::warning title=Maestro needed a retry::The flows passed on attempt ${attempt}." \
        "The earlier attempt died in the device driver, not in an assertion."
    fi
    exit 0
  fi

  if ! grep -q "${INFRA_FAULT}" "${LOG}"; then
    echo "::error title=A Maestro flow failed::A flow ran and failed. This is a result," \
      "not a flake, so it is not retried. Read the maestro-debug artifact before changing anything."
    exit "${status}"
  fi

  if [ "${attempt}" -ge "${MAX_ATTEMPTS}" ]; then
    echo "::error title=The Maestro device driver died on every attempt::${INFRA_FAULT}" \
      "after ${MAX_ATTEMPTS} attempts. That is no longer a flake - treat it as a real failure."
    exit "${status}"
  fi

  echo "::warning title=The Maestro device driver died::${INFRA_FAULT} on attempt" \
    "${attempt}; retrying. No flow assertion failed."
  attempt=$((attempt + 1))
done
