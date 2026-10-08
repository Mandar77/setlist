plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.setlist.ocrcollector"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.setlist.ocrcollector"
        // 24 matches ML Kit's own floor. Raising it would not make the collector better;
        // lowering it below what the library supports fails at dependency resolution.
        minSdk = 24
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    // The instrumented test IS the collector: there is no app to ship, only a host
    // process for ML Kit to run inside. Debug signing is correct here for the same
    // reason it is correct for the emulator APKs — nothing is distributed.
    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    // BUNDLED, not the Play-Services-delivered model. `text-recognition` ships the model
    // inside the APK; the `play-services-mlkit-text-recognition` variant downloads it
    // from Google Play on first use. On a CI emulator that download is a network
    // dependency that can be slow, absent, or silently stale — and an engine that has
    // not finished downloading reads nothing, which would score as "ML Kit is terrible at
    // handwriting" rather than as "the model never arrived".
    implementation("com.google.mlkit:text-recognition:16.0.1")

    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
