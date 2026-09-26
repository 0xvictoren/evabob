import 'package:flutter/widgets.dart';

import 'dynamic_client_native.dart'
    if (dart.library.js_interop) 'dynamic_client_web.dart' as impl;

/// The parts of a Dynamic user that Evabob reads.
class DynamicProfile {
  const DynamicProfile({
    this.userId,
    required this.sessionId,
    this.email,
    this.phoneNumber,
  });

  final String? userId;
  final String sessionId;

  /// The profile email, or the first verified email credential.
  final String? email;
  final String? phoneNumber;
}

/// Dynamic email sign-in, one implementation per platform.
///
/// Android and iOS use the Dynamic Flutter SDK (a headless WebView). The
/// web-app uses Dynamic's JavaScript SDK through `web-app/web/js/
/// dynamic_bridge.js`. Both hand [EvabobAuth] the same full Dynamic JWT, which
/// the server verifies the same way.
abstract class DynamicAuthClient {
  factory DynamicAuthClient.create({
    required String environmentId,
    required String appName,
    required String appOrigin,
    required bool debug,
  }) =>
      impl.createDynamicAuthClient(
        environmentId: environmentId,
        appName: appName,
        appOrigin: appOrigin,
        debug: debug,
      );

  /// Resolves once the client can send a code.
  Future<void> ready();

  /// The current full JWT, if signed in.
  String? get token;

  DynamicProfile? get profile;

  Stream<String?> get tokenChanges;

  Stream<DynamicProfile?> get profileChanges;

  Future<void> sendEmailOtp(String email);

  Future<void> resendEmailOtp();

  Future<void> verifyEmailOtp(String code);

  Future<void> logout();

  /// Widget that must stay mounted for the client to work (the phone SDK's
  /// WebView). None in the browser.
  Widget? get overlay;
}
