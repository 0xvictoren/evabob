import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../notifications/money_alerts.dart';

/// The two sounds money makes in the app.
///
/// `money_in.mp3` when money reaches the person — a payment received, a held
/// payment released or returned to them, a circle payout, a refund.
/// `money_out.wav` when a payment they make goes through.
///
/// One place, so a payment that is announced twice (the live alert and the
/// Money in screen's own check) chimes once, and one switch turns both off.
class MoneySounds {
  MoneySounds._();

  static final MoneySounds instance = MoneySounds._();

  static const _prefsKey = 'money_sounds_enabled';

  final AudioPlayer _in = AudioPlayer();
  final AudioPlayer _out = AudioPlayer();
  final Map<String, DateTime> _recent = {};
  StreamSubscription<Map<String, dynamic>>? _alerts;
  bool _ready = false;

  bool enabled = true;

  Future<void> _ensureReady() async {
    if (_ready) return;
    _ready = true;
    try {
      // Plays over music rather than stopping it, and stays quiet when an
      // iPhone is on silent.
      final ctx = AudioContextConfig(
        focus: AudioContextConfigFocus.mixWithOthers,
        respectSilence: true,
      ).build();
      for (final p in [_in, _out]) {
        await p.setAudioContext(ctx);
        await p.setReleaseMode(ReleaseMode.stop);
      }
    } catch (e) {
      debugPrint('MoneySounds setup: $e');
    }
  }

  /// Reads the on/off setting and starts listening for money arriving.
  Future<void> start(MoneyAlerts alerts) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      enabled = prefs.getBool(_prefsKey) ?? true;
    } catch (_) {}
    _alerts ??= alerts.events.listen((alert) {
      if (isMoneyIn(alert)) {
        playIn(
          key: alert['txHash']?.toString() ??
              alert['transferId']?.toString() ??
              alert['tag']?.toString(),
        );
      }
    });
  }

  Future<void> setEnabled(bool value) async {
    enabled = value;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_prefsKey, value);
    } catch (_) {}
  }

  /// Whether an alert means money has just reached this person.
  static bool isMoneyIn(Map<String, dynamic> alert) {
    final flag = alert['moneyIn'];
    return flag == true || flag == '1' || alert['kind'] == 'money_in';
  }

  /// Money arrived. [key] (a transaction hash) keeps one payment from
  /// chiming twice when it is reported by more than one path.
  void playIn({String? key}) => _play(_in, 'sounds/money_in.mp3', key);

  /// A payment the person made went through.
  void playOut({String? key}) => _play(_out, 'sounds/money_out.wav', key);

  Future<void> _play(AudioPlayer player, String asset, String? key) async {
    if (!enabled) return;
    final now = DateTime.now();
    _recent.removeWhere((_, at) => now.difference(at).inSeconds > 60);
    if (key != null && key.isNotEmpty) {
      final dedupe = '$asset|$key';
      if (_recent.containsKey(dedupe)) return;
      _recent[dedupe] = now;
    }
    await _ensureReady();
    try {
      await player.stop();
      await player.play(AssetSource(asset));
    } catch (e) {
      // A sound that fails must never affect the payment it announces.
      debugPrint('MoneySounds: $e');
    }
  }
}
