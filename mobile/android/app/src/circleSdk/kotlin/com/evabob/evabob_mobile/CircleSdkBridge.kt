package com.evabob.evabob_mobile

import android.app.Activity
import circle.programmablewallet.sdk.WalletSdk
import circle.programmablewallet.sdk.api.ApiError
import circle.programmablewallet.sdk.api.Callback
import circle.programmablewallet.sdk.api.ExecuteWarning
import circle.programmablewallet.sdk.presentation.SettingsManagement
import circle.programmablewallet.sdk.result.ExecuteResult
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Circle's native wallet SDK, for confirming with fingerprint instead of the
 * PIN.
 *
 * The web SDK the app otherwise uses for PINs has no biometrics; Circle offers
 * them only in its native SDKs. The person turns it on once (setBiometricsPin,
 * which asks for their PIN and enrols the fingerprint); after that `execute`
 * shows the fingerprint prompt, with the PIN as the fallback.
 *
 * Built only when android/local.properties holds a GitHub token for Circle's
 * package registry; otherwise the stub in src/noCircleSdk is compiled.
 */
object CircleSdkBridge {
    private const val CHANNEL = "evabob/circle_sdk"
    private const val ENDPOINT = "https://api.circle.com/v1/w3s/"
    private var initialisedFor: String? = null

    fun register(engine: FlutterEngine, activity: Activity) {
        MethodChannel(engine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "available" -> result.success(true)
                    "setBiometricsPin" -> {
                        ensureInit(activity, call.argument<String>("appId").orEmpty())
                        WalletSdk.setBiometricsPin(
                            activity,
                            call.argument<String>("userToken").orEmpty(),
                            call.argument<String>("encryptionKey").orEmpty(),
                            replyOnce(result),
                        )
                    }
                    "execute" -> {
                        ensureInit(activity, call.argument<String>("appId").orEmpty())
                        val ids = call.argument<List<String>>("challengeIds").orEmpty()
                        WalletSdk.execute(
                            activity,
                            call.argument<String>("userToken").orEmpty(),
                            call.argument<String>("encryptionKey").orEmpty(),
                            ids.toTypedArray<String?>(),
                            replyOnce(result),
                        )
                    }
                    else -> result.notImplemented()
                }
            } catch (t: Throwable) {
                result.success(mapOf("ok" to false, "error" to (t.message ?: t.toString())))
            }
        }
    }

    private fun ensureInit(activity: Activity, appId: String) {
        if (appId.isEmpty() || initialisedFor == appId) return
        val settings = SettingsManagement()
        settings.setEnableBiometricsPin(true)
        WalletSdk.init(activity.applicationContext, WalletSdk.Configuration(ENDPOINT, appId, settings))
        initialisedFor = appId
    }

    /** One answer per call, whichever of the SDK's callbacks fires. */
    private fun replyOnce(result: MethodChannel.Result): Callback<ExecuteResult> {
        val done = AtomicBoolean(false)
        fun reply(value: Map<String, Any?>) {
            if (done.compareAndSet(false, true)) result.success(value)
        }
        return object : Callback<ExecuteResult> {
            override fun onError(error: Throwable): Boolean {
                val canceled = error is ApiError && error.code == ApiError.ErrorCode.userCanceled
                reply(
                    mapOf(
                        "ok" to false,
                        "canceled" to canceled,
                        "code" to (if (error is ApiError) error.code?.name else null),
                        "error" to (error.message ?: error.toString()),
                    ),
                )
                // The SDK closes its own screen.
                return false
            }

            override fun onWarning(warning: ExecuteWarning, executeResult: ExecuteResult?): Boolean {
                reply(mapOf("ok" to (executeResult != null), "warning" to warning.toString()))
                return false
            }

            override fun onResult(executeResult: ExecuteResult) {
                // Signing steps (App Kit permits) hand their signature back to
                // the server, as the web PIN screen does.
                reply(mapOf("ok" to true, "signature" to executeResult.data.signature))
            }
        }
    }
}
