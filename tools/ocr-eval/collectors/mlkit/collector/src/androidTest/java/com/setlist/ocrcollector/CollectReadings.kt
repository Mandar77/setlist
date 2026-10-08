package com.setlist.ocrcollector

import android.graphics.BitmapFactory
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The ML Kit collector. Reads the M2-01 corpus and writes the same `<engine>.json`
 * contract every other collector writes (ADR-014).
 *
 * It is an instrumented test because ML Kit runs on a device and there is no honest way
 * to drive it off one. It is NOT a test of this project's code and asserts almost
 * nothing: its job is to produce readings, and the scoring happens in `tools/ocr-eval`
 * where every engine is graded by the same arithmetic.
 *
 * The two assertions it does make are about the COLLECTOR rather than the engine — that
 * it found a corpus, and that it read all of it. Both exist because the failure they
 * catch is indistinguishable from a bad engine once the numbers reach the report: a
 * collector that silently read 12 of 620 images would publish a confident average over
 * whichever 12 it managed.
 */
class CollectReadings {

    /**
     * Where the corpus was pushed and where the readings go.
     *
     * Passed as an instrumentation argument rather than hard-coded: the path differs
     * between an emulator and a physical device, and a wrong constant fails as "no
     * images found", which reads like an empty corpus rather than a wrong path.
     */
    private val corpusDir: File
        get() {
            val arg = InstrumentationRegistry.getArguments().getString("corpus")
                ?: "/sdcard/ocr-corpus"
            return File(arg)
        }

    @Test
    fun readEveryImage() {
        val images = corpusDir.listFiles { file -> file.name.endsWith(".jpg") }
            ?.sortedBy { it.name }
            ?: emptyList()

        assertTrue(
            "no images under ${corpusDir.absolutePath} — the corpus was not pushed, " +
                "which would otherwise be reported as an engine that read nothing",
            images.isNotEmpty(),
        )

        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val readings = StringBuilder("[\n")
        var written = 0

        try {
            for (image in images) {
                val id = image.name.removeSuffix(".jpg")
                val bitmap = BitmapFactory.decodeFile(image.absolutePath)
                    ?: error("could not decode ${image.name}")

                val started = System.nanoTime()
                // ML Kit's API is callback-based and the test thread must not return
                // before it completes. A latch rather than `Tasks.await`, which throws if
                // called from the main thread and would make this depend on which thread
                // the runner happens to use.
                val latch = CountDownLatch(1)
                var lines: List<String> = emptyList()
                var failure: Exception? = null

                recognizer.process(InputImage.fromBitmap(bitmap, 0))
                    .addOnSuccessListener { result ->
                        lines = result.textBlocks
                            .flatMap { block -> block.lines }
                            .map { line -> line.text.trim() }
                            .filter { it.isNotEmpty() }
                        latch.countDown()
                    }
                    .addOnFailureListener { error ->
                        failure = error as? Exception ?: RuntimeException(error)
                        latch.countDown()
                    }

                // Bounded. A hang here would otherwise burn the whole CI job's timeout
                // and report nothing at all.
                check(latch.await(60, TimeUnit.SECONDS)) { "ML Kit timed out on ${image.name}" }
                failure?.let { throw it }

                val ms = (System.nanoTime() - started) / 1_000_000
                bitmap.recycle()

                if (written > 0) readings.append(",\n")
                readings.append(
                    """  {"imageId": ${quote(id)}, "ms": $ms, "lines": [${
                        lines.joinToString(", ") { quote(it) }
                    }]}"""
                )
                written += 1
            }
        } finally {
            recognizer.close()
        }

        readings.append("\n]\n")

        // The app's own external files directory: writable without a storage permission
        // on every API level this supports, and `adb pull`-able afterwards.
        val target = File(
            InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null),
            "mlkit.json",
        )
        target.writeText(readings.toString())

        assertTrue(
            "read $written of ${images.size} images — a partial corpus would publish a " +
                "confident average over whichever images happened to succeed",
            written == images.size,
        )
    }

    /**
     * JSON string escaping, by hand because this module has no JSON dependency.
     *
     * Hand-rolled escaping is usually the wrong answer and Semgrep is right to flag it in
     * HTML. Here the input is OCR output — arbitrary text, by definition untrusted
     * (CLAUDE.md) — so every control character is escaped by codepoint rather than only
     * the obvious few. Adding a JSON library to an instrumented test to serialize one
     * array of strings would be the larger risk.
     */
    private fun quote(value: String): String {
        val out = StringBuilder("\"")
        for (character in value) {
            when {
                character == '"' -> out.append("\\\"")
                character == '\\' -> out.append("\\\\")
                character == '\n' -> out.append("\\n")
                character == '\r' -> out.append("\\r")
                character == '\t' -> out.append("\\t")
                character.code < 0x20 -> out.append(String.format("\\u%04x", character.code))
                else -> out.append(character)
            }
        }
        return out.append('"').toString()
    }
}
