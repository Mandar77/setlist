#!/usr/bin/env bash
# Run the ML Kit instrumented collector and pull its readings off the device.
#
# A script rather than inline workflow lines for the reason android-emulator-runner makes
# unavoidable: it executes each line of `script:` in its own `sh -c`, so a multi-line
# command, a loop, or a `set -e` on line one all fail in confusing ways — a `for` loop in
# this job once died on "end of file unexpected". One line calling one script is the shape
# that works, and this file gets shellcheck like every other script here.
set -euo pipefail

MODULE_DIR="tools/ocr-eval/collectors/mlkit"
PACKAGE="com.setlist.ocrcollector"
READINGS_DIR="golden/ocr-generated/readings"
CORPUS_ON_DEVICE="${1:-/sdcard/ocr-corpus}"

echo "::group::install the collector and its test"
adb install -r -t "${MODULE_DIR}/collector/build/outputs/apk/debug/collector-debug.apk"
adb install -r -t \
  "${MODULE_DIR}/collector/build/outputs/apk/androidTest/debug/collector-debug-androidTest.apk"
echo "::endgroup::"

pushed="$(adb shell "ls ${CORPUS_ON_DEVICE}/*.jpg 2>/dev/null | wc -l" | tr -d '\r')"
echo "ml kit: ${pushed} image(s) on the device at ${CORPUS_ON_DEVICE}"
if [ "${pushed}" -lt 1 ]; then
  echo "::error title=The corpus never reached the device::adb push found no .jpg under ${CORPUS_ON_DEVICE}. Collecting now would report an engine that read nothing, which is indistinguishable from a bad engine once it is averaged."
  exit 1
fi

echo "::group::ml kit instrumented collection"
# `am instrument` exits 0 even when the test FAILS — it reports success for having run
# the instrumentation, not for the result. The output has to be inspected, which is why
# this captures it rather than trusting the exit code.
log="${RUNNER_TEMP:-/tmp}/mlkit-instrument.log"
adb shell am instrument -w \
  -e corpus "${CORPUS_ON_DEVICE}" \
  "${PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner" 2>&1 | tee "${log}"
echo "::endgroup::"

if grep -qE "^(FAILURES|INSTRUMENTATION_CODE: 0)" "${log}" || grep -q "Error in" "${log}"; then
  echo "::error title=The ML Kit collector failed on the device::See the instrumentation log above; the collector asserts it read EVERY image, so a partial run fails here rather than publishing an average over whichever images succeeded."
  exit 1
fi

mkdir -p "${READINGS_DIR}"
adb pull "/sdcard/Android/data/${PACKAGE}/files/mlkit.json" "${READINGS_DIR}/mlkit.json"

# Pulled, but is it a corpus or an empty array? `adb pull` succeeds on a file of "[]".
count="$(grep -o '"imageId"' "${READINGS_DIR}/mlkit.json" | wc -l | tr -d ' ')"
echo "ml kit: pulled ${count} reading(s) into ${READINGS_DIR}/mlkit.json"
if [ "${count}" -lt "${pushed}" ]; then
  echo "::error title=Fewer readings than images::${count} readings for ${pushed} images."
  exit 1
fi
