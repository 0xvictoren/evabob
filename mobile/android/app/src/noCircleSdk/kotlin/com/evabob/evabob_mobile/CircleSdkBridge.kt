package com.evabob.evabob_mobile

import android.app.Activity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Built when Circle's native SDK is not available to this build (no GitHub
 * token in android/local.properties). Says so, and the app keeps confirming
 * with the PIN. See src/circleSdk for the real bridge.
 */
object CircleSdkBridge {
    fun register(engine: FlutterEngine, @Suppress("UNUSED_PARAMETER") activity: Activity) {
        MethodChannel(engine.dartExecutor.binaryMessenger, "evabob/circle_sdk")
            .setMethodCallHandler { call, result ->
                if (call.method == "available") {
                    result.success(false)
                } else {
                    result.success(
                        mapOf("ok" to false, "error" to "Fingerprint confirmation is not in this build."),
                    )
                }
            }
    }
}
