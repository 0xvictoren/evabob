import 'dart:convert';

import 'package:crypto/crypto.dart';
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

  final _auth = LocalAuthentication();
  final _secure = const FlutterSecureStorage();

  bool _ready = false;
  bool _enabled = false;
  bool _bioEnabled = false;
  bool _unlocked = false;
  bool _bioAvailable = false;
  String? _error;

  bool get ready => _ready;
  bool get enabled => _enabled;
  bool get bioEnabled => _bioEnabled;
  bool get unlocked => !_enabled || _unlocked;
  bool get bioAvailable => _bioAvailable;
  bool get needsUnlock => _enabled && !_unlocked;
  String? get error => _error;

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _enabled = prefs.getBool(_prefEnabled) ?? false;
    _bioEnabled = prefs.getBool(_prefBio) ?? false;
    try {
      _bioAvailable =
          await _auth.canCheckBiometrics || await _auth.isDeviceSupported();
    } catch (_) {
      _bioAvailable = false;
    }
    // If lock never configured, stay unlocked.
    if (_enabled) {
      final hash = await _secure.read(key: _securePinHash);
      if (hash == null || hash.isEmpty) {
        _enabled = false;
        await prefs.setBool(_prefEnabled, false);
      }
    }
    _unlocked = !_enabled;
    _ready = true;
    notifyListeners();
  }

  String _hashPin(String pin, String salt) {
    final bytes = utf8.encode('$salt::$pin');
    return sha256.convert(bytes).toString();
  }

  /// Create or replace app PIN (4–8 digits recommended).
  Future<bool> setPin(String pin, {bool enableBiometrics = false}) async {
    final cleaned = pin.trim();
    if (cleaned.length < 4 || cleaned.length > 12) {
      _error = 'PIN must be 4–12 characters';
      notifyListeners();
      return false;
    }
    final salt = DateTime.now().microsecondsSinceEpoch.toString();
    final hash = _hashPin(cleaned, salt);
    await _secure.write(key: _secureSalt, value: salt);
    await _secure.write(key: _securePinHash, value: hash);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_prefEnabled, true);
    await prefs.setBool(_prefBio, enableBiometrics && _bioAvailable);
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
    _enabled = false;
    _bioEnabled = false;
    _unlocked = true;
    _error = null;
    notifyListeners();
  }

  Future<bool> unlockWithPin(String pin) async {
    final salt = await _secure.read(key: _secureSalt) ?? '';
    final expected = await _secure.read(key: _securePinHash) ?? '';
    if (expected.isEmpty) {
      _unlocked = true;
      notifyListeners();
      return true;
    }
    final ok = _hashPin(pin.trim(), salt) == expected;
    if (ok) {
      _unlocked = true;
      _error = null;
    } else {
      _error = 'Incorrect PIN';
    }
    notifyListeners();
    return ok;
  }

  Future<bool> unlockWithBiometrics() async {
    if (!_bioEnabled || !_bioAvailable) return false;
    try {
      final ok = await _auth.authenticate(
        localizedReason: 'Unlock Evabob',
        biometricOnly: false,
        persistAcrossBackgrounding: true,
      );
      if (ok) {
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

  /// Call when app goes to background so next open requires unlock.
  void lockNow() {
    if (!_enabled) return;
    _unlocked = false;
    notifyListeners();
  }
}
