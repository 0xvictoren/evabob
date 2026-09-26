import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../platform/browser.dart';

/// Persistence for the signed-in session record.
///
/// The record holds the Dynamic access JWT, the wallet address and the user's
/// email. It used to live in `SharedPreferences`, which is plain text on disk:
/// on Android it is an XML file readable by anyone with a rooted device, an
/// ADB backup, or another process running as the same user. A leaked JWT is a
/// live session against the API.
///
/// It now lives in `flutter_secure_storage`, which is backed by the Android
/// Keystore and the iOS Keychain. `flutter_secure_storage` was already a
/// dependency but only held the app-lock PIN hash.
///
/// Values written by an older build are migrated on first read and the plain
/// copy is deleted, so an upgrade does not silently sign everyone out and does
/// not leave the old token behind.
///
/// In the web-app the record lives in the tab's `sessionStorage` instead, so
/// closing the tab signs the person out: browser testers sign in each time.
class SessionStore {
  SessionStore({FlutterSecureStorage? secure})
      : _secure = secure ?? const FlutterSecureStorage();

  final FlutterSecureStorage _secure;

  /// Secure-storage key for the current record.
  static const _secureKey = 'evabob_session_v1';

  /// Plain-text keys written by earlier builds. Read once, then removed.
  static const _legacyPrefsKeys = <String>[
    'evabob_auth_v4',
    'evabob_auth_v3',
  ];

  /// Returns the stored session record, migrating a legacy plain-text copy.
  Future<String?> read() async {
    if (kIsWeb) return Browser.sessionGet(_secureKey);
    try {
      final secure = await _secure.read(key: _secureKey);
      if (secure != null && secure.isNotEmpty) return secure;
    } catch (e) {
      // A Keystore failure must not lock the user out permanently; fall
      // through to the legacy read so they can at least be migrated.
      debugPrint('SessionStore.read secure: $e');
    }
    return _migrateFromPrefs();
  }

  Future<void> write(String record) async {
    if (kIsWeb) {
      Browser.sessionSet(_secureKey, record);
      return;
    }
    try {
      await _secure.write(key: _secureKey, value: record);
    } catch (e) {
      // Do NOT fall back to SharedPreferences — that is the leak this class
      // exists to close. Losing the record only costs a re-login.
      debugPrint('SessionStore.write: $e');
      return;
    }
    await _clearPrefs();
  }

  Future<void> clear() async {
    if (kIsWeb) {
      Browser.sessionRemove(_secureKey);
      return;
    }
    try {
      await _secure.delete(key: _secureKey);
    } catch (e) {
      debugPrint('SessionStore.clear secure: $e');
    }
    await _clearPrefs();
  }

  /// Moves a record written by an older build into secure storage.
  Future<String?> _migrateFromPrefs() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      for (final key in _legacyPrefsKeys) {
        final legacy = prefs.getString(key);
        if (legacy == null || legacy.isEmpty) continue;
        try {
          await _secure.write(key: _secureKey, value: legacy);
        } catch (e) {
          // Migration failed; leave the legacy copy so the session survives,
          // and try again on the next launch.
          debugPrint('SessionStore migrate write: $e');
          return legacy;
        }
        await _clearPrefs();
        debugPrint('SessionStore: migrated $key to secure storage');
        return legacy;
      }
    } catch (e) {
      debugPrint('SessionStore.migrate: $e');
    }
    return null;
  }

  Future<void> _clearPrefs() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      for (final key in _legacyPrefsKeys) {
        await prefs.remove(key);
      }
    } catch (e) {
      debugPrint('SessionStore._clearPrefs: $e');
    }
  }
}
