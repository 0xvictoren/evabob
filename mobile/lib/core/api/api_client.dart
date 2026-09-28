import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../config/env.dart';

/// HTTP client for Evabob TypeScript API.
class ApiClient {
  ApiClient({http.Client? client, String? baseUrl, String? userId})
      : _client = client ?? http.Client(),
        baseUrl = baseUrl ?? Env.apiBaseUrl,
        _userId = userId ?? 'dev-user';

  final http.Client _client;
  final String baseUrl;
  String _userId;
  String? _authToken;

  void setUserId(String? id) =>
      _userId = (id == null || id.isEmpty) ? 'dev-user' : id;

  void setAuthToken(String? token) => _authToken = token;

  /// Authentication headers for private media fetched by Image.network.
  Map<String, String> get mediaHeaders {
    final token = _authToken;
    return token == null || token.isEmpty
        ? const <String, String>{}
        : <String, String>{'Authorization': 'Bearer $token'};
  }

  /// Called when the server refuses the sign-in a request carried (401 with
  /// code SESSION_EXPIRED, or a token it cannot verify). Gets the token that
  /// request sent -- null when it sent none -- so EvabobAuth ends the session
  /// only when it is the one still in use.
  void Function(String? rejectedToken)? onSessionExpired;

  Map<String, String> _headers(String? token) {
    final h = <String, String>{
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Only for local development servers (ALLOW_HEADER_AUTH); a real API
      // goes by the sign-in token alone. A browser may not send it at all:
      // the API does not allow it across origins, and every request from the
      // web-app was blocked before it left.
      if (!kIsWeb) 'x-user-id': _userId,
    };
    if (token != null && token.isNotEmpty) {
      h['Authorization'] = 'Bearer $token';
    }
    return h;
  }

  Uri _u(String path, [Map<String, String>? q]) {
    final base = baseUrl.endsWith('/')
        ? baseUrl.substring(0, baseUrl.length - 1)
        : baseUrl;
    return Uri.parse('$base$path').replace(queryParameters: q);
  }

  Future<Map<String, dynamic>> get(String path,
      {Map<String, String>? query}) async {
    final token = _authToken;
    final res = await _client
        .get(_u(path, query), headers: _headers(token))
        .timeout(const Duration(seconds: 30));
    return _decode(res, token);
  }

  Future<Map<String, dynamic>> post(
    String path, {
    Map<String, dynamic>? body,

    /// Override default 60s (use longer for CCTP finish / Iris mint).
    Duration? timeout,
  }) async {
    final token = _authToken;
    final res = await _client
        .post(
          _u(path),
          headers: _headers(token),
          body: jsonEncode(body ?? {}),
        )
        .timeout(timeout ?? const Duration(seconds: 60));
    return _decode(res, token);
  }

  Future<Map<String, dynamic>> patch(
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final token = _authToken;
    final res = await _client
        .patch(
          _u(path),
          headers: _headers(token),
          body: jsonEncode(body ?? {}),
        )
        .timeout(const Duration(seconds: 30));
    return _decode(res, token);
  }

  Future<Map<String, dynamic>> delete(
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final token = _authToken;
    final res = await _client
        .delete(
          _u(path),
          headers: _headers(token),
          body: jsonEncode(body ?? {}),
        )
        .timeout(const Duration(seconds: 30));
    return _decode(res, token);
  }

  Map<String, dynamic> _decode(http.Response res, String? sentToken) {
    Map<String, dynamic> json = {};
    try {
      final d = jsonDecode(res.body);
      if (d is Map<String, dynamic>) json = d;
    } catch (_) {
      json = {'raw': res.body};
    }
    final authenticationRejected = res.statusCode == 401 &&
        (json['code'] == 'SESSION_EXPIRED' ||
            json['code'] == 'SESSION_INVALID' ||
            json['error'] == 'unauthorized');
    if (authenticationRejected) {
      onSessionExpired?.call(sentToken);
      throw ApiException(
        401,
        json['detail']?.toString() ??
            'Your sign-in could not be verified. Sign in again.',
      );
    }
    if (res.statusCode >= 400) {
      var err = json['error']?.toString() ?? res.body;
      // A server fault carries a short reference to its log line; keep it so
      // the person can quote it.
      final ref = json['ref']?.toString();
      if (err == 'internal_error' && ref != null && ref.isNotEmpty) {
        err = 'internal_error:$ref';
      }
      debugPrint('ApiClient ${res.statusCode}: $err');
      throw ApiException(res.statusCode, err);
    }
    return json;
  }

  void dispose() => _client.close();
}

class ApiException implements Exception {
  ApiException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => 'ApiException($status): $message';
}
