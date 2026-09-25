import 'dart:async';
import 'dart:convert';

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
/// Alerts arrive two ways. This listens on the user's own Pusher channel,
/// which works while the app is running or backgrounded. Push through
/// Firebase (PushRegistration) reaches the phone when the app is closed. Both
/// carry the same tag, and a tagged alert always lands in the same
/// notification slot, so a phone that gets both shows one notification.
class MoneyAlerts {
  MoneyAlerts(this._pusher);

  final PusherService _pusher;
  final _plugin = FlutterLocalNotificationsPlugin();

  bool _ready = false;
  String? _userId;

  /// Called with an alert's data when its notification is tapped.
  void Function(Map<String, dynamic> data)? onOpen;

  /// Whether to show a notification for an alert while the app is open. The
  /// chat uses it to stay quiet about the conversation already on screen.
  bool Function(Map<String, dynamic> alert)? shouldNotify;

  final _events = StreamController<Map<String, dynamic>>.broadcast();

  /// Every alert as it arrives, for screens that react live — the seller's
  /// Money in screen chimes on `money_in` instead of waiting for its next poll.
  Stream<Map<String, dynamic>> get events => _events.stream;

  /// Opens the platform permission prompt from an explanatory in-app screen.
  ///
  /// Safe to call after startup: initialization and permission requests are
  /// idempotent on both supported mobile platforms.
  ///
  /// Returns whether notifications are allowed afterwards. Asks again even
  /// after startup — the first ask may have been dismissed.
  Future<bool> requestPermission() async {
    await _ensureReady();
    try {
      await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission();
      await _plugin
          .resolvePlatformSpecificImplementation<
              IOSFlutterLocalNotificationsPlugin>()
          ?.requestPermissions(alert: true, badge: true, sound: true);
    } catch (e) {
      debugPrint('MoneyAlerts permission: $e');
    }
    return permissionGranted();
  }

  /// Whether the phone currently lets Evabob show notifications. Read from
  /// the system each time, so the in-app prompt disappears once it is on —
  /// it used to ask again every time the screen opened.
  Future<bool> permissionGranted() async {
    try {
      final android = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      if (android != null) {
        return await android.areNotificationsEnabled() ?? false;
      }
      final ios = _plugin.resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin>();
      if (ios != null) {
        final p = await ios.checkPermissions();
        return p?.isEnabled ?? false;
      }
    } catch (e) {
      debugPrint('MoneyAlerts permission check: $e');
    }
    return false;
  }

  /// Android needs a channel declared before anything can be posted to it, and
  /// its importance is fixed at creation — raising it later is ignored, so it
  /// is set high here to make sure a payment actually surfaces. Push from the
  /// server names this same channel.
  static const _channel = AndroidNotificationChannel(
    'evabob_money',
    'Money',
    description: 'When money arrives or a held payment is released',
    importance: Importance.high,
  );

  /// Money reaching the person, with the app's money-in sound. Push from the
  /// server names this channel for those alerts, so a closed app plays it too.
  static const _moneyInChannel = AndroidNotificationChannel(
    'evabob_money_in',
    'Money received',
    description: 'When money reaches you',
    importance: Importance.high,
    playSound: true,
    sound: RawResourceAndroidNotificationSound('money_in'),
  );

  Future<void> _ensureReady() async {
    if (_ready) return;
    try {
      await _plugin.initialize(
        const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          iOS: DarwinInitializationSettings(),
        ),
        onDidReceiveNotificationResponse: (response) {
          final payload = response.payload;
          if (payload == null || payload.isEmpty) return;
          try {
            final data = jsonDecode(payload);
            if (data is Map) onOpen?.call(Map<String, dynamic>.from(data));
          } catch (_) {}
        },
      );
      final android = _plugin.resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();
      await android?.createNotificationChannel(_channel);
      await android?.createNotificationChannel(_moneyInChannel);
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

  /// A push that arrived while the app was open. Shown like the Pusher copy.
  void showPush({String? title, String? body, Map<String, dynamic>? data}) {
    _show({
      ...?data,
      if (title != null) 'title': title,
      if (body != null) 'body': body,
    });
  }

  void _show(Map<String, dynamic> alert) {
    _events.add(alert);
    // A balance nudge refreshes what is on screen; it is not news to show.
    if (alert['kind'] == 'balance_changed') return;
    // Never expose names, amounts or message text on the lock screen.
    const title = 'Evabob';
    const body = 'You have a new private update.';
    if (!_ready) return;
    if (shouldNotify != null && !shouldNotify!(alert)) return;
    // While the app is open the money-in sound is played by the app itself
    // (MoneySounds), so the notification stays silent rather than doubling it.
    final moneyIn = alert['moneyIn'] == true ||
        alert['moneyIn'] == '1' ||
        alert['kind'] == 'money_in';
    final tag = alert['tag']?.toString();
    final payload = jsonEncode({
      for (final k in [
        'kind',
        'transferId',
        'jobId',
        'txHash',
        'link',
        'threadId'
      ])
        if (alert[k] != null) k: alert[k].toString(),
    });
    try {
      _plugin.show(
        // With a tag, one fixed slot: Android keys notifications by tag and
        // id (FCM posts tagged ones with id 0), and iOS replaces a request with
        // the same identifier. Without one, a distinct id, so a second payment
        // does not silently replace a first the user has not read yet.
        tag == null
            ? DateTime.now().millisecondsSinceEpoch.remainder(1 << 31)
            : (defaultTargetPlatform == TargetPlatform.android
                ? 0
                : tag.hashCode & 0x7fffffff),
        title,
        body,
        NotificationDetails(
          android: AndroidNotificationDetails(
            (moneyIn ? _moneyInChannel : _channel).id,
            (moneyIn ? _moneyInChannel : _channel).name,
            channelDescription:
                (moneyIn ? _moneyInChannel : _channel).description,
            importance: Importance.high,
            priority: Priority.high,
            tag: tag,
            // The second copy of the same alert replaces the first silently.
            onlyAlertOnce: true,
            silent: moneyIn,
            visibility: NotificationVisibility.private,
          ),
          iOS: const DarwinNotificationDetails(),
        ),
        payload: payload,
      );
    } catch (e) {
      debugPrint('MoneyAlerts show: $e');
    }
  }
}
