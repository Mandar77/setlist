// Versions resolved from Google's Maven repository, never written from memory. Maven
// Central's copy of com.android.tools.build:gradle stops at 2.3.0, so "latest" from the
// wrong registry is wrong by nearly a decade — and it fails as a confusing resolution
// error rather than as "no such version". See README.md.
//
// AGP 9.4.1 is the latest STABLE. The repository's own `release` marker points at
// 9.5.0-alpha08; this project does not take alphas.
// No Kotlin plugin, and that is not an omission.
//
// This project originally declared `org.jetbrains.kotlin.android`, and AGP refused it:
//
//   The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support
//   since AGP 9.0. Solution: Remove the plugin from this project's build file.
//
// AGP 9 compiles Kotlin itself, so declaring the standalone plugin is now an error
// rather than a redundancy. The Kotlin version follows AGP's bundled one; nothing here
// pins it, which is why the long-resolved 2.4.20 is gone from this file.
//
// Keeping the note because the obvious repair when a Kotlin file fails to compile is to
// add the Kotlin plugin back, and that is exactly wrong on AGP 9.
plugins {
    id("com.android.application") version "9.4.1" apply false
}
