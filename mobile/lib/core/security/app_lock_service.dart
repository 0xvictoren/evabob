import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// First-layer device lock: app PIN and/or biometrics before wallet access.
///
/// Independent of Dynamic login and Circle wallet PIN.
class AppLockService extends ChangeNotifier {
  static const _prefEnabled = 'evabob_app_lock_enabled_v1';
  static const _prefBio = 'evabob_app_lock_bio_v1';
  static const _securePinHash = 'evabob_app_lock_pin_hash_v1';
  static const _secureSalt = 'evabob_app_lock_salt_v1';
  static const _secureFailedAttempts = 'evabob_app_lock_failed_attempts_v1';
  static const _secureLockedUntil = 'evabob_app_lock_locked_until_v1';
  static const _securePinLength = 'evabob_app_lock_pin_length_v1';
  static const _maxPinAttempts = 10;

  /// How long the app may sit in the background before it asks for the PIN
  /// again. Switching away for a moment — copying an address, answering a
  /// message — should not lock someone out.
  static const lockAfter = Duration(seconds: 10);

  final _auth = LocalAuthentication();
  final _secure = const FlutterSecureStorage();

  bool _ready = false;
  bool _enabled = false;
  bool _bioEnabled = false;
  bool _unlocked = false;
  bool _bioAvailable = false;
  String? _error;
  int _failedAttempts = 0;
  DateTime? _lockedUntil;
  int? _pinLength;
  DateTime? _backgroundedAt;

  /// Digits in the PIN, once known, so the lock screen can check it the
  /// moment the last one is typed. Unknown for a PIN set before this was
  /// recorded, until the first unlock with it.
  int? get pinLength => _pinLength;

  bool get ready => _ready;
  bool get enabled => _enabled;
  bool get bioEnabled => _bioEnabled;
  bool get unlocked => !_enabled || _unlocked;
  bool get bioAvailable => _bioAvailable;
  bool get needsUnlock => _enabled && !_unlocked;
  String? get error => _error;
  int get failedAttempts => _failedAttempts;
  DateTime? get lockedUntil => _lockedUntil;
  bool get pinBlocked =>
      _lockedUntil != null && DateTime.now().isBefore(_lockedUntil!);
  Duration get retryAfter =>
      pinBlocked ? _lockedUntil!.difference(DateTime.now()) : Duration.zero;

  Future<void> init() async {
    // The web-app signs out when the tab closes; a device lock on top of that
    // has nothing to protect, and browsers have no Keystore for the PIN hash.
    if (kIsWeb) {
      _ready = true;
      notifyListeners();
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    _enabled = prefs.getBool(_prefEnabled) ?? false;
    _bioEnabled = prefs.getBool(_prefBio) ?? false;
    try {
      _bioAvailable =
          await _auth.canCheckBiometrics || await _auth.isDeviceSupported();
    } catch (_) {
      _bioAvailable = false;
    }
    // Once enabled, missing or corrupt secure state must fail closed. Silently
    // disabling the lock would expose the wallet after a storage failure.
    if (_enabled) {
      try {
        final hash = await _secure.read(key: _securePinHash);
        final salt = await _secure.read(key: _secureSalt);
        if (hash == null || hash.isEmpty || salt == null || salt.isEmpty) {
          _error =
              'App-lock data is unavailable. Use biometrics or reinstall the app.';
        }
        _pinLength = int.tryParse(
          await _secure.read(key: _securePinLength) ?? '',
        );
        _failedAttempts = int.tryParse(
              await _secure.read(key: _secureFailedAttempts) ?? '',
            ) ??
            0;
        final lockedMs = int.tryParse(
          await _secure.read(key: _secureLockedUntil) ?? '',
        );
        if (lockedMs != null) {
          _lockedUntil = DateTime.fromMillisecondsSinceEpoch(lockedMs);
          if (!pinBlocked) {
            _lockedUntil = null;
            await _secure.delete(key: _secureLockedUntil);
          }
        }
      } catch (_) {
        _error =
            'App-lock data is unavailable. Use biometrics or reinstall the app.';
      }
    }
    _unlocked = !_enabled;
    _ready = true;
    notifyListeners();
  }

  String _legacyHashPin(String pin, String salt) {
    final bytes = utf8.encode('$salt::$pin');
    return sha256.convert(bytes).toString();
  }

  final _argon2id = Argon2id(
    memory: 19 * 1024,
    parallelism: 1,
    iterations: 2,
    hashLength: 32,
  );

  Future<String> _hashPin(String pin, String salt) async {
    final key = await _argon2id.deriveKeyFromPassword(
      password: pin,
      nonce: base64Url.decode(base64Url.normalize(salt)),
    );
    return 'argon2id:v=19:m=19456:t=2:p=1:${base64UrlEncode(await key.extractBytes())}';
  }

  bool _constantTimeEquals(String a, String b) {
    final aa = utf8.encode(a);
    final bb = utf8.encode(b);
    var diff = aa.length ^ bb.length;
    final length = max(aa.length, bb.length);
    for (var i = 0; i < length; i++) {
      diff |= (i < aa.length ? aa[i] : 0) ^ (i < bb.length ? bb[i] : 0);
    }
    return diff == 0;
  }

  /// Create or replace a numeric app PIN.
  Future<bool> setPin(String pin, {bool enableBiometrics = false}) async {
    final cleaned = pin.trim();
    if (!RegExp(r'^\d{6,12}$').hasMatch(cleaned)) {
      _error = 'PIN must be 6–12 digits';
      notifyListeners();
      return false;
    }
    final random = Random.secure();
    final salt =
        base64UrlEncode(List<int>.generate(16, (_) => random.nextInt(256)));
    final hash = await _hashPin(cleaned, salt);
    await _secure.write(key: _secureSalt, value: salt);
    await _secure.write(key: _securePinHash, value: hash);
    await _secure.write(key: _securePinLength, value: '${cleaned.length}');
    _pinLength = cleaned.length;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_prefEnabled, true);
    await prefs.setBool(_prefBio, enableBiometrics && _bioAvailable);
    await _clearFailures();
    _enabled = true;
    _bioEnabled = enableBiometrics && _bioAvailable;
    _unlocked = true;
    _error = null;
    notifyListeners();
    return true;
  }

  Future<void> setBiometrics(bool on) async {
    final prefs = await SharedPreferences.getInstance();
    _bioEnabled = on && _bioAvailable && _enabled;
    await prefs.setBool(_prefBio, _bioEnabled);
    notifyListeners();
  }

  Future<void> disableLock() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_prefEnabled, false);
    await prefs.setBool(_prefBio, false);
    await _secure.delete(key: _securePinHash);
    await _secure.delete(key: _secureSalt);
    await _secure.delete(key: _secureFailedAttempts);
    await _secure.delete(key: _secureLockedUntil);
    await _secure.delete(key: _securePinLength);
    _pinLength = null;
    _enabled = false;
    _bioEnabled = false;
    _unlocked = true;
    _error = null;
    notifyListeners();
  }

  Future<bool> unlockWithPin(String pin) async {
    if (pinBlocked) {
      _error = 'Too many attempts. Try again later or use biometrics.';
      notifyListeners();
      return false;
    }
    final salt = await _secure.read(key: _secureSalt) ?? '';
    final expected = await _secure.read(key: _securePinHash) ?? '';
    if (expected.isEmpty || salt.isEmpty) {
      _unlocked = false;
      _error =
          'App-lock data is unavailable. Use biometrics or reinstall the app.';
      notifyListeners();
      return false;
    }
    final candidate = expected.startsWith('argon2id:')
        ? await _hashPin(pin.trim(), salt)
        : _legacyHashPin(pin.trim(), salt);
    final ok = _constantTimeEquals(candidate, expected);
    if (ok) {
      // Upgrade legacy SHA-256 PINs after a successful proof.
      if (!expected.startsWith('argon2id:')) {
        await _secure.write(
          key: _securePinHash,
          value: await _hashPin(pin.trim(), salt),
        );
      }
      if (_pinLength != pin.trim().length) {
        _pinLength = pin.trim().length;
        await _secure.write(key: _securePinLength, value: '$_pinLength');
      }
      await _clearFailures();
      _unlocked = true;
      _error = null;
    } else {
      await _recordFailure();
    }
    notifyListeners();
    return ok;
  }

  Future<bool> unlockWithBiometrics() async {
    if (!_bioEnabled || !_bioAvailable) return false;
    try {
      final ok = await _auth.authenticate(
        localizedReason: 'Unlock Evabob',
        biometricOnly: true,
        persistAcrossBackgrounding: true,
      );
      if (ok) {
        await _clearFailures();
        _unlocked = true;
        _error = null;
        notifyListeners();
      }
      return ok;
    } catch (e) {
      _error = e.toString();
      notifyListeners();
      return false;
    }
  }

  Future<void> _clearFailures() async {
    _failedAttempts = 0;
    _lockedUntil = null;
    await _secure.delete(key: _secureFailedAttempts);
    await _secure.delete(key: _secureLockedUntil);
  }

  Future<void> _recordFailure() async {
    _failedAttempts += 1;
    // Persistent exponential backoff. The tenth failure enforces a 24-hour
    // hard stop; a successful biometric proof clears it immediately.
    final seconds = _failedAttempts >= _maxPinAttempts
        ? 24 * 60 * 60
        : min(30 * (1 << max(0, _failedAttempts - 1)), 60 * 60);
    _lockedUntil = DateTime.now().add(Duration(seconds: seconds));
    _error = _failedAttempts >= _maxPinAttempts
        ? 'PIN entry is locked for 24 hours. Use biometrics to unlock sooner.'
        : 'Incorrect PIN. Try again after the security delay.';
    await _secure.write(
      key: _secureFailedAttempts,
      value: _failedAttempts.toString(),
    );
    await _secure.write(
      key: _secureLockedUntil,
      value: _lockedUntil!.millisecondsSinceEpoch.toString(),
    );
  }

  /// The app went to the background. Nothing locks yet: [onResumed] decides,
  /// by how long it was away.
  void markBackgrounded() {
    if (!_enabled || !_unlocked) return;
    _backgroundedAt ??= DateTime.now();
  }

  /// The app is back. Locks when it was away for [lockAfter] or longer.
  void onResumed() {
    final at = _backgroundedAt;
    _backgroundedAt = null;
    if (at == null || !_enabled) return;
    if (DateTime.now().difference(at) >= lockAfter) lockNow();
  }

  /// Locks at once.
  void lockNow() {
    if (!_enabled) return;
    _unlocked = false;
    notifyListeners();
  }
}
