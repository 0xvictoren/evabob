import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// What one native confirmation came to.
class NativeConfirm {
  const NativeConfirm({
    required this.ok,
    this.canceled = false,
    this.signature,
    this.error,
  });

  factory NativeConfirm.fromMap(Object? raw) {
    final m = raw is Map ? Map<String, dynamic>.from(raw) : const <String, dynamic>{};
    final sig = m['signature']?.toString();
    return NativeConfirm(
      ok: m['ok'] == true,
      canceled: m['canceled'] == true,
      signature: sig != null && sig.startsWith('0x') ? sig : null,
      error: m['error']?.toString(),
    );
  }

  final bool ok;

  /// The person backed out. Not a failure to retry another way.
  final bool canceled;

  /// For signing steps, what they signed — relayed to the server.
  final String? signature;
  final String? error;
}

/// Circle's native wallet SDK: confirming with fingerprint or Face ID instead
/// of typing the PIN.
///
/// Circle's web SDK, which shows the PIN screen, has no biometrics — only its
/// native Android and iOS SDKs do. They are wired in on the platform side
/// (android/app/src/circleSdk, ios/Runner/AppDelegate.swift) when the build
/// includes them; [available] says whether this build does.
class CircleNativeSdk {
  CircleNativeSdk._();

  static const _channel = MethodChannel('evabob/circle_sdk');
  static bool? _available;

  static Future<bool> available() async {
    if (_available != null) return _available!;
    if (kIsWeb ||
        !(defaultTargetPlatform == TargetPlatform.android ||
            defaultTargetPlatform == TargetPlatform.iOS)) {
      return _available = false;
    }
    try {
      _available = await _channel.invokeMethod<bool>('available') ?? false;
    } catch (_) {
      _available = false;
    }
    return _available!;
  }

  /// Turns biometric confirmation on: Circle asks for the PIN once, then
  /// enrols the fingerprint or face.
  static Future<NativeConfirm> enableBiometrics({
    required String appId,
    required String userToken,
    required String encryptionKey,
  }) async {
    try {
      return NativeConfirm.fromMap(await _channel.invokeMethod<Object?>(
        'setBiometricsPin',
        {'appId': appId, 'userToken': userToken, 'encryptionKey': encryptionKey},
      ));
    } catch (e) {
      return NativeConfirm(ok: false, error: e.toString());
    }
  }

  /// Confirms one challenge: fingerprint or Face ID, with the PIN as fallback.
  static Future<NativeConfirm> confirm({
    required String appId,
    required String userToken,
    required String encryptionKey,
    required String challengeId,
  }) async {
    try {
      return NativeConfirm.fromMap(await _channel.invokeMethod<Object?>(
        'execute',
        {
          'appId': appId,
          'userToken': userToken,
          'encryptionKey': encryptionKey,
          'challengeIds': [challengeId],
        },
      ));
    } catch (e) {
      return NativeConfirm(ok: false, error: e.toString());
    }
  }
}
