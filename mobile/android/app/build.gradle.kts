import java.net.URI
import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Circle's native wallet SDK brings fingerprint / Face ID confirmation. It is
// served from GitHub Packages, which needs a GitHub token even though the
// package is public. Put these in android/local.properties (never committed):
//   pwsdk.maven.username=<your GitHub username>
//   pwsdk.maven.password=<a token with the read:packages scope>
// Without them the app builds exactly as before, confirming with the PIN.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val circleSdkUser: String? = localProps.getProperty("pwsdk.maven.username")
val circleSdkToken: String? = localProps.getProperty("pwsdk.maven.password")
val withCircleSdk = !circleSdkUser.isNullOrBlank() && !circleSdkToken.isNullOrBlank()

// Release signing is supplied by the build environment/CI, never by a checked-in
// file. Debug builds remain available for local testing.
val releaseKeystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
val releaseKeystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")
val releaseSigningReady = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

fun decodeDartDefines(encoded: String?): Map<String, String> =
    encoded
        ?.split(',')
        ?.mapNotNull { item ->
            val decoded = runCatching {
                String(Base64.getDecoder().decode(item), Charsets.UTF_8)
            }.getOrNull() ?: return@mapNotNull null
            val separator = decoded.indexOf('=')
            if (separator <= 0) null
            else decoded.substring(0, separator) to decoded.substring(separator + 1)
        }
        ?.toMap()
        .orEmpty()

fun isHttpsOrigin(value: String): Boolean {
    val uri = runCatching { URI(value) }.getOrNull() ?: return false
    return uri.scheme.equals("https", ignoreCase = true) &&
        !uri.host.isNullOrBlank() &&
        uri.rawUserInfo == null &&
        uri.rawQuery == null &&
        uri.rawFragment == null &&
        (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
}

val validateReleaseApiBaseUrl by tasks.registering {
    group = "verification"
    description = "Rejects Android release builds without an HTTPS API origin."
    doLast {
        val defines = decodeDartDefines(project.findProperty("dart-defines")?.toString())
        val apiBaseUrl = defines["API_BASE_URL"].orEmpty()
        if (!isHttpsOrigin(apiBaseUrl)) {
            throw GradleException(
                "Release API_BASE_URL must be an exact HTTPS origin " +
                    "(for example https://api.evabob.app). Received: " +
                    if (apiBaseUrl.isBlank()) "<missing>" else apiBaseUrl,
            )
        }
    }
}

if (withCircleSdk) {
    repositories {
        maven {
            url = uri("https://maven.pkg.github.com/circlefin/w3s-android-sdk")
            credentials {
                username = circleSdkUser
                password = circleSdkToken
            }
        }
    }
}

android {
    namespace = "com.evabob.evabob_mobile"

    sourceSets {
        getByName("main") {
            // The real bridge with the SDK, or a stub that says it is absent.
            java.srcDir(if (withCircleSdk) "src/circleSdk/kotlin" else "src/noCircleSdk/kotlin")
        }
    }
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

    signingConfigs {
        if (releaseSigningReady) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            isShrinkResources = false
        }
        release {
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
}

// Every APK/AAB release path passes this gate, including Flutter's
// `flutter build apk` and `flutter build appbundle` commands.
tasks.configureEach {
    if (name == "preReleaseBuild") {
        dependsOn(validateReleaseApiBaseUrl)
        doFirst {
            if (!releaseSigningReady) {
                throw GradleException(
                    "Release signing is not configured. Set ANDROID_KEYSTORE_PATH, " +
                        "ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, and ANDROID_KEY_PASSWORD.",
                )
            }
        }
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    if (withCircleSdk) {
        implementation("circle.programmablewallet:sdk:1.0.1189")
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
