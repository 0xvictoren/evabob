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

  void setAuthToken(String? token) => _authToken = token;

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
