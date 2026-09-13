import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../config/env.dart';

/// Settlement: EUR / USDC (1 USDC ≈ 1 USD).
/// Local display: NGN (Naira).
///
/// Prefers Evabob API `GET /v1/fx/rates` (server holds EXCHANGE_RATE_API_KEY).
/// Falls back to open ExchangeRate-API, then last cache / defaults.
class FxService extends ChangeNotifier {
  FxService({http.Client? client, String? apiBaseUrl})
      : _client = client ?? http.Client(),
        _apiBaseUrl = apiBaseUrl ?? Env.resolveApiBaseUrl();

  final http.Client _client;
  final String _apiBaseUrl;

  Map<String, double> _usdRates = {
    'NGN': 1628.0,
    'EUR': 0.92,
    'USD': 1.0,
    'USDC': 1.0,
  };

  DateTime? _lastFetch;
  String _source = 'fallback';
  Timer? _timer;

  DateTime get updatedAt => _lastFetch ?? DateTime.now();
  double get usdToNgn => _usdRates['NGN']!;
  double get usdToEur => _usdRates['EUR']!;
  String get source => _source;

  void start() {
    // Don't block first frame — refresh in background after a tick
    Future<void>.delayed(const Duration(milliseconds: 300), refresh);
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 45), (_) => refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _client.close();
    super.dispose();
  }

  String get _serverFxUrl {
    final base = _apiBaseUrl.endsWith('/')
        ? _apiBaseUrl.substring(0, _apiBaseUrl.length - 1)
        : _apiBaseUrl;
    // ApiClient uses .../v1; base may or may not include /v1
    if (base.endsWith('/v1')) return '$base/fx/rates';
    return '$base/v1/fx/rates';
  }

  Future<void> refresh() async {
    if (await _tryServer()) return;
    if (await _tryOpenErApi()) return;
    debugPrint('FxService: using cached rates (source=$_source)');
    _lastFetch ??= DateTime.now();
    notifyListeners();
  }

  Future<bool> _tryServer() async {
    try {
      final res = await _client
          .get(Uri.parse(_serverFxUrl))
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return false;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final ngn = (data['ngn'] as num?)?.toDouble();
      final eur = (data['eur'] as num?)?.toDouble();
      if (ngn == null || ngn <= 0) return false;
      _usdRates = {
        'NGN': ngn,
        'EUR': eur != null && eur > 0 ? eur : _usdRates['EUR']!,
        'USD': 1.0,
        'USDC': 1.0,
      };
      _source = data['source']?.toString() ?? 'server';
      _lastFetch = DateTime.now();
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('FxService server: $e');
      return false;
    }
  }

  /// Unauthenticated fallback if API is down.
  Future<bool> _tryOpenErApi() async {
    try {
      final uri = Uri.parse('https://open.er-api.com/v6/latest/USD');
      final res = await _client.get(uri).timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) return false;
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      final rates = data['rates'] as Map<String, dynamic>?;
      if (rates == null) return false;
      _usdRates = {
        'NGN': (rates['NGN'] as num?)?.toDouble() ?? _usdRates['NGN']!,
        'EUR': (rates['EUR'] as num?)?.toDouble() ?? _usdRates['EUR']!,
        'USD': 1.0,
        'USDC': 1.0,
      };
      _source = 'open.er-api.com';
      _lastFetch = DateTime.now();
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('FxService open API: $e');
      return false;
    }
  }

  double ngnToUsdc(double ngn) => ngn / _usdRates['NGN']!;
  double usdcToNgn(double usdc) => usdc * _usdRates['NGN']!;
  double eurToUsdc(double eur) => eur / _usdRates['EUR']!;
  double usdcToEur(double usdc) => usdc * _usdRates['EUR']!;
  double eurToNgn(double eur) => eurToUsdc(eur) * _usdRates['NGN']!;
  double ngnToEur(double ngn) => usdcToEur(ngnToUsdc(ngn));

  String liveRateLine() {
    final n = _usdRates['NGN']!.toStringAsFixed(0);
    return '1 USD = ₦$n';
  }
}
