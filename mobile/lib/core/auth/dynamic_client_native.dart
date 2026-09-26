import 'package:dynamic_sdk/dynamic_sdk.dart';
import 'package:flutter/widgets.dart';

import 'dynamic_client.dart';

DynamicAuthClient createDynamicAuthClient({
  required String environmentId,
  required String appName,
  required String appOrigin,
  required bool debug,
}) =>
    _NativeDynamicClient(
      DynamicSDK.init(
        props: ClientProps(
          environmentId: environmentId,
          appName: appName,
          appOrigin: appOrigin,
          apiBaseUrl: 'https://app.dynamicauth.com/api/v0',
          logLevel: debug ? LoggerLevel.debug : LoggerLevel.error,
          debugWebview: debug,
          debug: debug ? ClientDebugProps(webview: true) : null,
        ),
      ),
    );

/// Android and iOS: the Dynamic Flutter SDK, unchanged.
class _NativeDynamicClient implements DynamicAuthClient {
  _NativeDynamicClient(this._sdk);

  final DynamicSDK _sdk;

  // Warm Dynamic WebView bridge before any OTP.
  @override
  Future<void> ready() =>
      Future<void>.delayed(const Duration(milliseconds: 1500));

  @override
  String? get token => _sdk.auth.token;

  @override
  DynamicProfile? get profile => _map(_sdk.auth.authenticatedUser);

  // Only the full token: the minified one carries no verified credentials,
  // so the server cannot confirm the email and says "unauthorized".
  @override
  Stream<String?> get tokenChanges => _sdk.auth.tokenChanges;

  @override
  Stream<DynamicProfile?> get profileChanges =>
      _sdk.auth.authenticatedUserChanges.map(_map);

  @override
  Future<void> sendEmailOtp(String email) => _sdk.auth.email.sendOTP(email);

  @override
  Future<void> resendEmailOtp() => _sdk.auth.email.resendOTP();

  @override
  Future<void> verifyEmailOtp(String code) => _sdk.auth.email.verifyOTP(code);

  @override
  Future<void> logout() => _sdk.auth.logout();

  @override
  Widget? get overlay => _sdk.dynamicWidget;

  static DynamicProfile? _map(UserProfile? profile) {
    if (profile == null) return null;
    var email = profile.email?.trim() ?? '';
    if (email.isEmpty) {
      for (final c in profile.verifiedCredentials) {
        if (c.format == JwtVerifiedCredentialFormatEnum.email) {
          final e = c.email ?? c.publicIdentifier;
          if (e != null && e.contains('@')) {
            email = e;
            break;
          }
        }
      }
    }
    return DynamicProfile(
      userId: profile.userId,
      sessionId: profile.sessionId,
      email: email.isEmpty ? null : email,
      phoneNumber: profile.phoneNumber,
    );
  }
}

