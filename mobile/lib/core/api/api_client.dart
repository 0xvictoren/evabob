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

  Map<String, String> get _headers {
    final h = <String, String>{
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-user-id': _userId,
    };
    final t = _authToken;
    if (t != null && t.isNotEmpty) {
      h['Authorization'] = 'Bearer $t';
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
    final res = await _client
        .get(_u(path, query), headers: _headers)
        .timeout(const Duration(seconds: 30));
    return _decode(res);
  }

  Future<Map<String, dynamic>> post(
    String path, {
    Map<String, dynamic>? body,

    /// Override default 60s (use longer for CCTP finish / Iris mint).
    Duration? timeout,
  }) async {
    final res = await _client
        .post(
          _u(path),
          headers: _headers,
          body: jsonEncode(body ?? {}),
        )
        .timeout(timeout ?? const Duration(seconds: 60));
    return _decode(res);
  }

  Future<Map<String, dynamic>> patch(
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final res = await _client
        .patch(
          _u(path),
          headers: _headers,
          body: jsonEncode(body ?? {}),
        )
        .timeout(const Duration(seconds: 30));
    return _decode(res);
  }

  Map<String, dynamic> _decode(http.Response res) {
    Map<String, dynamic> json = {};
    try {
      final d = jsonDecode(res.body);
      if (d is Map<String, dynamic>) json = d;
    } catch (_) {
      json = {'raw': res.body};
    }
    if (res.statusCode >= 400) {
      final err = json['error']?.toString() ?? res.body;
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
