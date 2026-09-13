plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.evabob.evabob_mobile"
    // Dynamic + modern plugins need compileSdk 36+
    compileSdk = maxOf(flutter.compileSdkVersion, 36)
    ndkVersion = flutter.ndkVersion

    compileOptions {
        // flutter_local_notifications uses java.time, which minSdk 28 does not
        // carry. Without desugaring the build fails at dex time rather than at
        // compile time, so the error arrives late and reads like a plugin fault.
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.evabob.evabob_mobile"
        // Dynamic Flutter / secure storage require minSdk 28+
        minSdk = maxOf(flutter.minSdkVersion, 28)
        targetSdk = maxOf(flutter.targetSdkVersion, 36)
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        multiDexEnabled = true
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            isShrinkResources = false
        }
        release {
            // Debug signing so release APK can be sideloaded during testing
            signingConfig = signingConfigs.getByName("debug")
            // shrinkResources requires minifyEnabled — keep both off for simple debug-style builds
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
