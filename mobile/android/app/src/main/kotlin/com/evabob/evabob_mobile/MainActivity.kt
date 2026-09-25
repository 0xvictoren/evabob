package com.evabob.evabob_mobile

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

// Screenshots are allowed: people take them to share receipts and to show the
// app in presentations. (FLAG_SECURE used to block them on every screen.)
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Fingerprint confirmation through Circle's native SDK (or a stub
        // saying it is not in this build).
        CircleSdkBridge.register(flutterEngine, this)
    }
}
