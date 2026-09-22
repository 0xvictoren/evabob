import 'package:flutter/foundation.dart';

/// Settlement: EUR / USDC (1 USDC ≈ 1 USD).
/// Local display: NGN (Naira).
///
/// The product rate is fixed at ₦1,390 for 1 USD / 1 USDC.
class FxService extends ChangeNotifier {
  FxService();

  static const double fixedUsdToNgn = 1390.0;

  final Map<String, double> _usdRates = {
    'NGN': fixedUsdToNgn,
    'EUR': 0.92,
    'USD': 1.0,
    'USDC': 1.0,
  };

  final DateTime _configuredAt = DateTime.now();

  DateTime get updatedAt => _configuredAt;
  double get usdToNgn => _usdRates['NGN']!;
  double get usdToEur => _usdRates['EUR']!;
  String get source => 'fixed';

  void start() {}

  Future<void> refresh() async {
    // Kept for callers that refresh all app services together.
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
