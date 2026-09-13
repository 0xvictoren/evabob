import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../chat/pusher_service.dart';

/// Tells the user when money arrives, instead of waiting for them to look.
///
/// Receiving was the one thing the app never announced. A payment landed, a
/// row appeared in Activity, and the person found out whenever they next
/// happened to open the app and pull to refresh. Chat had been real-time since
/// the beginning; money had not.
///
/// This listens on the user's own Pusher channel and raises a system
/// notification. Two honest limits, worth stating rather than letting anyone
/// assume otherwise:
///
///  * It works while the app is running or backgrounded, not while it is
///    force-quit. Waking a closed app needs FCM or APNs and a Firebase
///    project.
///  * The server decides what is worth announcing. Nothing here polls, so an
///    event the server never sends is silence.
class MoneyAlerts {
  MoneyAlerts(this._pusher);

  final PusherService _pusher;
  final _plugin = FlutterLocalNotificationsPlugin();

  bool _ready = false;
  String? _userId;

  /// Android needs a channel declared before anything can be posted to it, and
  /// its importance is fixed at creation — raising it later is ignored, so it
  /// is set high here to make sure a payment actually surfaces.
  static const _channel = AndroidNotificationChannel(
    'evabob_money',
    'Money',
    description: 'When money arrives or a held payment is released',
    importance: Importance.high,
  );

  Future<void> _ensureReady() async {
    if (_ready) return;
    try {
      await _plugin.initialize(
        const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          iOS: DarwinInitializationSettings(),
        ),
      );
      final android = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      await android?.createNotificationChannel(_channel);
      // Asked for here rather than at launch: permission means more to someone
      // who has just been told what it is for than to someone who has not seen
      // the app yet.
      await android?.requestNotificationsPermission();
      await _plugin
          .resolvePlatformSpecificImplementation<
              IOSFlutterLocalNotificationsPlugin>()
          ?.requestPermissions(alert: true, badge: true, sound: true);
      _ready = true;
    } catch (e) {
      // A refused or unavailable permission must not take the app down with
      // it; the money still arrives, it just arrives quietly.
      debugPrint('MoneyAlerts init: $e');
    }
  }

  /// Starts listening for this user. Safe to call repeatedly.
  Future<void> start(String userId) async {
    if (userId.isEmpty || userId == _userId) return;
    if (_userId != null) await _pusher.unsubscribeUserAlerts(_userId!);
    _userId = userId;
    await _ensureReady();
    await _pusher.subscribeUserAlerts(userId, _show);
  }

  Future<void> stop() async {
    final id = _userId;
    _userId = null;
    if (id != null) await _pusher.unsubscribeUserAlerts(id);
  }

  void _show(Map<String, dynamic> alert) {
    final title = alert['title']?.toString() ?? 'Evabob';
    final body = alert['body']?.toString() ?? '';
    if (body.isEmpty) return;
    if (!_ready) return;
    try {
      _plugin.show(
        // Distinct per notification so a second payment does not silently
        // replace the first one the user has not read yet.
        DateTime.now().millisecondsSinceEpoch.remainder(1 << 31),
        title,
        body,
        NotificationDetails(
          android: AndroidNotificationDetails(
            _channel.id,
            _channel.name,
            channelDescription: _channel.description,
            importance: Importance.high,
            priority: Priority.high,
          ),
          iOS: const DarwinNotificationDetails(),
        ),
      );
    } catch (e) {
      debugPrint('MoneyAlerts show: $e');
    }
  }
}
