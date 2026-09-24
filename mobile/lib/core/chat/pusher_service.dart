import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:pusher_channels_flutter/pusher_channels_flutter.dart';

import '../config/env.dart';

/// Realtime chat via Pusher Channels.
class PusherService {
  PusherService();

  final PusherChannelsFlutter _pusher = PusherChannelsFlutter.getInstance();
  bool _ready = false;
  final Map<String, void Function(Map<String, dynamic>)> _handlers = {};

  /// Alerts about this user's own money, keyed by their user channel.
  final Map<String, void Function(Map<String, dynamic>)> _alertHandlers = {};

  /// Session token sent to /v1/pusher/auth. The server checks thread
  /// membership before signing a channel, so an unauthenticated authorizer
  /// call is rejected. Kept in sync by [EvabobApp] on every auth change.
  String? _authToken;

  void setAuthToken(String? token) {
    final changed = token != _authToken;
    _authToken = token;
    // A channel asked for before the session token arrived was refused by the
    // server and never tried again — so live chat and alerts only started
    // working after a restart. Ask again once there is a token to sign with.
    if (changed && token != null && token.isNotEmpty && _ready) {
      refreshConnection();
    }
  }

  /// Reconnects if the socket dropped (the phone slept, the network
  /// changed) and asks again for every channel this app listens on.
  Future<void> refreshConnection() async {
    if (!Env.hasPusher) return;
    if (!_ready) await init();
    if (!_ready) return;
    try {
      if (_pusher.connectionState != 'CONNECTED' &&
          _pusher.connectionState != 'CONNECTING') {
        await _pusher.connect();
      }
    } catch (e) {
      debugPrint('Pusher reconnect: $e');
    }
    final channels = [..._alertHandlers.keys, ..._handlers.keys];
    for (final channel in channels) {
      if (_pusher.getChannel(channel) != null && _subscribed.contains(channel)) {
        continue;
      }
      try {
        await _pusher.unsubscribe(channelName: channel);
      } catch (_) {}
      try {
        await _pusher.subscribe(channelName: channel);
      } catch (e) {
        debugPrint('resubscribe $channel: $e');
      }
    }
  }

  /// Channels the server has confirmed. A refused one is dropped from here
  /// so [refreshConnection] knows to ask again.
  final Set<String> _subscribed = {};

  bool get isReady => _ready && Env.hasPusher;

  Future<void> init() async {
    if (!Env.hasPusher) {
      debugPrint('Pusher: no key configured');
      return;
    }
    try {
      await _pusher.init(
        apiKey: Env.pusherKey,
        cluster: Env.pusherCluster,
        onAuthorizer: (channelName, socketId, options) async {
          final base = Env.resolveApiBaseUrl();
          final token = _authToken;
          final res = await http.post(
            Uri.parse('$base/v1/pusher/auth'),
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              if (token != null && token.isNotEmpty)
                'Authorization': 'Bearer $token',
            },
            body:
                'socket_id=${Uri.encodeComponent(socketId)}&channel_name=${Uri.encodeComponent(channelName)}',
          );
          if (res.statusCode >= 400) {
            throw Exception('Pusher auth ${res.statusCode}: ${res.body}');
          }
          return jsonDecode(res.body) as Map;
        },
        onEvent: (event) {
          // Two kinds of traffic share this socket: chat messages, and alerts
          // about the user's own money. They are dispatched separately because
          // a chat handler expects a message and would make nonsense of an
          // alert.
          final name = event.eventName;
          if (name != 'message' && name != 'alert') return;
          if (event.data == null) return;
          try {
            final data = event.data is String
                ? jsonDecode(event.data as String)
                : event.data;
            if (data is! Map) return;
            final channel = event.channelName;
            final payload = Map<String, dynamic>.from(data);
            if (name == 'alert') {
              _alertHandlers[channel]?.call(payload);
            } else {
              _handlers[channel]?.call(payload);
            }
          } catch (e) {
            debugPrint('Pusher event parse: $e');
          }
        },
        onSubscriptionSucceeded: (channelName, data) {
          _subscribed.add(channelName);
        },
        onSubscriptionError: (message, e) {
          debugPrint('Pusher subscription error: $message $e');
          _subscribed.clear();
        },
        onConnectionStateChange: (current, previous) {
          if (current.toUpperCase() != 'CONNECTED') _subscribed.clear();
        },
        onError: (message, code, e) {
          debugPrint('Pusher error: $message $code $e');
        },
      );
      await _pusher.connect();
      _ready = true;
      debugPrint('Pusher connected');
    } catch (e) {
      debugPrint('Pusher init failed: $e');
    }
  }

  Future<void> subscribeChat(
    String threadId,
    void Function(Map<String, dynamic>) onMessage,
  ) async {
    if (!_ready) await init();
    if (!_ready) return;
    final channel = 'private-chat-$threadId';
    _handlers[channel] = onMessage;
    try {
      await _pusher.subscribe(channelName: channel);
    } catch (e) {
      debugPrint('subscribe $channel: $e');
    }
  }

  Future<void> unsubscribeChat(String threadId) async {
    final channel = 'private-chat-$threadId';
    _handlers.remove(channel);
    _subscribed.remove(channel);
    try {
      await _pusher.unsubscribe(channelName: channel);
    } catch (_) {}
  }

  /// Listens for alerts about this user's own money.
  ///
  /// The channel is named after the user and the server only signs it for
  /// the session that owns it, so subscribing to someone else's is refused
  /// rather than merely discouraged.
  Future<void> subscribeUserAlerts(
    String userId,
    void Function(Map<String, dynamic>) onAlert,
  ) async {
    if (userId.isEmpty) return;
    if (!_ready) await init();
    if (!_ready) return;
    final channel = 'private-user-$userId';
    _alertHandlers[channel] = onAlert;
    try {
      await _pusher.subscribe(channelName: channel);
    } catch (e) {
      debugPrint('subscribe $channel: $e');
    }
  }

  Future<void> unsubscribeUserAlerts(String userId) async {
    final channel = 'private-user-$userId';
    _alertHandlers.remove(channel);
    _subscribed.remove(channel);
    try {
      await _pusher.unsubscribe(channelName: channel);
    } catch (_) {}
  }

  Future<void> dispose() async {
    try {
      await _pusher.disconnect();
    } catch (_) {}
  }
}
