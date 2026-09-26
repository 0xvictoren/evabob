import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:flutter/widgets.dart';

import 'dynamic_client.dart';

DynamicAuthClient createDynamicAuthClient({
  required String environmentId,
  required String appName,
  required String appOrigin,
  required bool debug,
}) =>
    _WebDynamicClient(environmentId: environmentId, appName: appName);

/// `window.evabobDynamic`, defined by `web-app/web/js/dynamic_bridge.js`.
/// Every call resolves to a JSON string: `{ok: true, ...}` or
/// `{ok: false, error: "..."}`, so errors keep Dynamic's own wording.
@JS('evabobDynamic')
external _Bridge? get _bridge;

extension type _Bridge(JSObject _) implements JSObject {
  external JSPromise<JSString> init(JSString environmentId, JSString appName);
  external JSPromise<JSString> sendEmailOtp(JSString email);
  external JSPromise<JSString> resendEmailOtp();
  external JSPromise<JSString> verifyEmailOtp(JSString code);
  external JSPromise<JSString> logout();
}

/// Web-app: Dynamic's JavaScript SDK.
///
/// The JS SDK keeps only the minified token, which has no verified
/// credentials and is refused by the server. The bridge returns the full JWT
/// from the verify response instead, and it is held here in memory; after a
/// page reload [EvabobAuth] restores it from the tab's session record.
class _WebDynamicClient implements DynamicAuthClient {
  _WebDynamicClient({required this.environmentId, required this.appName});

  final String environmentId;
  final String appName;

  final _tokens = StreamController<String?>.broadcast();
  final _profiles = StreamController<DynamicProfile?>.broadcast();
  Future<void>? _init;
  String? _token;
  DynamicProfile? _profile;

  _Bridge get _js {
    final b = _bridge;
    if (b == null) {
      throw Exception('Sign-in could not load. Refresh the page and try again.');
    }
    return b;
  }

  Future<Map<String, dynamic>> _call(JSPromise<JSString> Function() run) async {
    final raw = (await run().toDart).toDart;
    final out = jsonDecode(raw) as Map<String, dynamic>;
    if (out['ok'] != true) {
      throw Exception(out['error']?.toString() ?? 'Sign-in failed');
    }
    return out;
  }

  /// Shared by every caller; forgotten on failure so the next call retries.
  @override
  Future<void> ready() => _init ??= Future(
        () => _call(() => _js.init(environmentId.toJS, appName.toJS)),
      ).then<void>((_) {}, onError: (Object e) {
        _init = null;
        throw e;
      });

  @override
  String? get token => _token;

  @override
  DynamicProfile? get profile => _profile;

  @override
  Stream<String?> get tokenChanges => _tokens.stream;

  @override
  Stream<DynamicProfile?> get profileChanges => _profiles.stream;

  @override
  Future<void> sendEmailOtp(String email) async {
    await ready();
    await _call(() => _js.sendEmailOtp(email.toJS));
  }

  @override
  Future<void> resendEmailOtp() async {
    await ready();
    await _call(() => _js.resendEmailOtp());
  }

  @override
  Future<void> verifyEmailOtp(String code) async {
    await ready();
    final out = await _call(() => _js.verifyEmailOtp(code.toJS));
    final jwt = out['jwt']?.toString();
    if (jwt == null || jwt.isEmpty) {
      throw Exception('Sign-in did not return a session');
    }
    final user = out['user'];
    if (user is Map) {
      String? s(String k) {
        final v = user[k]?.toString().trim();
        return v == null || v.isEmpty ? null : v;
      }

      _profile = DynamicProfile(
        userId: s('userId'),
        sessionId: s('sessionId') ?? '',
        email: s('email'),
        phoneNumber: s('phoneNumber'),
      );
    }
    _token = jwt;
    _tokens.add(jwt);
    _profiles.add(_profile);
  }

  @override
  Future<void> logout() async {
    _token = null;
    _profile = null;
    final b = _bridge;
    if (b == null) return;
    try {
      await b.logout().toDart;
    } catch (_) {}
  }

  @override
  Widget? get overlay => null;
}
