import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../config/env.dart';
import '../navigation/app_link_service.dart';
import 'money_alerts.dart';

/// Registers this phone for push, so alerts reach it while the app is closed.
///
/// Pusher (MoneyAlerts) only reaches a running or backgrounded app. The
/// held-payment rules depend on reaching someone who is not holding the phone
/// — "the work was delivered, you have 7 days", "releases tomorrow", "your
/// payer cancelled" — so the same alerts also come through Firebase Cloud
/// Messaging (which delivers to iPhones through APNs).
///
/// Off unless the Firebase identifiers were supplied at build time (see
/// [Env]). Every failure is swallowed: push is an extra channel, never a
/// reason for sign-in or a payment to fail.
class PushRegistration {
  PushRegistration(this._api, this._alerts, this._links);

  final ApiClient _api;
  final MoneyAlerts _alerts;
  final AppLinkService _links;

  bool _initialised = false;
  String? _token;
  String? _userId;
  final List<StreamSubscription<Object?>> _subs = [];

  static String get _appId =>
      defaultTargetPlatform == TargetPlatform.iOS
          ? Env.firebaseIosAppId
          : Env.firebaseAndroidAppId;

  static bool get configured =>
      !kIsWeb &&
      Env.firebaseApiKey.isNotEmpty &&
      Env.firebaseProjectId.isNotEmpty &&
      Env.firebaseMessagingSenderId.isNotEmpty &&
      _appId.isNotEmpty;

  String get _platform =>
      defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';

  Future<bool> _init() async {
    if (_initialised) return true;
    if (!configured) return false;
    try {
      if (Firebase.apps.isEmpty) {
        await Firebase.initializeApp(
          options: FirebaseOptions(
            apiKey: Env.firebaseApiKey,
            appId: _appId,
            messagingSenderId: Env.firebaseMessagingSenderId,
            projectId: Env.firebaseProjectId,
            iosBundleId: Env.firebaseIosBundleId.isEmpty
                ? null
                : Env.firebaseIosBundleId,
          ),
        );
      }
      _initialised = true;
      return true;
    } catch (e) {
      debugPrint('Push init: $e');
      return false;
    }
  }

  /// Registers this phone for [userId]. Safe to call repeatedly.
  Future<void> start(String userId) async {
    if (userId.isEmpty || userId == _userId) return;
    if (!await _init()) return;
    _userId = userId;
    try {
      final messaging = FirebaseMessaging.instance;
      final settings = await messaging.requestPermission();
      if (settings.authorizationStatus == AuthorizationStatus.denied) return;
      // On iPhones the APNs token must exist before an FCM token can.
      if (defaultTargetPlatform == TargetPlatform.iOS) {
        await messaging.getAPNSToken();
      }
      final token = await messaging.getToken();
      if (token != null) await _register(token);

      for (final s in _subs) {
        await s.cancel();
      }
      _subs
        ..clear()
        ..add(messaging.onTokenRefresh.listen(_register))
        // In the foreground FCM shows nothing by itself; show it the same way
        // the Pusher copy is shown, so the two collapse into one by tag.
        ..add(FirebaseMessaging.onMessage.listen((message) {
          _alerts.showPush(
            title: message.notification?.title,
            body: message.notification?.body,
            data: message.data,
          );
        }))
        ..add(FirebaseMessaging.onMessageOpenedApp.listen(
          (message) => openFromData(message.data),
        ));
      final initial = await messaging.getInitialMessage();
      if (initial != null) openFromData(initial.data);
    } catch (e) {
      debugPrint('Push start: $e');
    }
  }

  Future<void> _register(String token) async {
    _token = token;
    try {
      await _api.post('/v1/users/me/push-devices', body: {
        'token': token,
        'platform': _platform,
      });
    } catch (e) {
      debugPrint('Push register: $e');
    }
  }

  /// Stops push to this phone for the signed-out account, so the next person
  /// to sign in here does not receive the previous one's alerts.
  ///
  /// The request is sent before anything awaits, so it carries the session
  /// even when the caller clears it straight after calling this.
  Future<void> stop() async {
    final token = _token;
    _userId = null;
    final unregister = token == null
        ? null
        : _api
            .delete('/v1/users/me/push-devices', body: {'token': token})
            .catchError((Object e) {
            debugPrint('Push unregister: $e');
            return <String, dynamic>{};
          });
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
    await unregister;
  }

  /// Opens the screen a notification is about.
  void openFromData(Map<String, dynamic> data) {
    final transferId = data['transferId']?.toString();
    // Operator alerts open the review, not the payment: an operator is not a
    // party to the hold and would not be allowed to see it there.
    if (data['kind'] == 'review_needed') {
      _links.open(Uri.parse(transferId != null && transferId.isNotEmpty
          ? 'evabob://review/$transferId'
          : 'evabob://reviews'));
      return;
    }
    if (transferId != null && transferId.isNotEmpty) {
      _links.open(Uri.parse('evabob://held/$transferId'));
      return;
    }
    // Invoices, circles and pots carry the link to open.
    final link = data['link']?.toString();
    if (link != null && link.startsWith('evabob://')) {
      _links.open(Uri.parse(link));
      return;
    }
    _links.open(Uri.parse('evabob://activity'));
  }
}
