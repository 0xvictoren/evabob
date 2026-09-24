import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../utils/money_format.dart';

/// The currency a person thinks in. Everything in the app is shown and typed
/// in it; money always moves as dollars (USDC) underneath.
enum DominantCurrency {
  ngn('NGN', '₦'),
  usd('USD', r'$');

  const DominantCurrency(this.code, this.symbol);
  final String code;
  final String symbol;

  static DominantCurrency? parse(String? code) {
    switch ((code ?? '').trim().toUpperCase()) {
      case 'NGN':
        return DominantCurrency.ngn;
      case 'USD':
        return DominantCurrency.usd;
    }
    return null;
  }
}

/// Settlement: EUR / USDC (1 USDC ≈ 1 USD).
/// Local display: NGN (Naira).
///
/// The product rate is fixed at ₦1,390 for 1 USD / 1 USDC.
class FxService extends ChangeNotifier {
  FxService() {
    dominant = DominantCurrency.ngn;
  }

  static const double fixedUsdToNgn = 1390.0;
  static const _prefDominant = 'evabob_dominant_currency_v1';

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

  /// Naira unless the person chose dollars.
  DominantCurrency _dominant = DominantCurrency.ngn;
  DominantCurrency get dominant => _dominant;
  set dominant(DominantCurrency value) {
    _dominant = value;
    moneyDisplayNgnRate = value == DominantCurrency.ngn ? fixedUsdToNgn : null;
  }
  bool get isNaira => dominant == DominantCurrency.ngn;

  /// Reads the choice saved on this phone.
  void start() {
    SharedPreferences.getInstance().then((prefs) {
      final saved = DominantCurrency.parse(prefs.getString(_prefDominant));
      if (saved != null && saved != dominant) {
        dominant = saved;
        notifyListeners();
      }
    }).catchError((_) {});
  }

  /// Sets the dominant currency here and remembers it on this phone. The
  /// caller saves it to the account as well.
  Future<void> setDominant(DominantCurrency value) async {
    if (value == dominant) return;
    dominant = value;
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_prefDominant, value.code);
    } catch (_) {}
  }

  /// The account's choice, as the server sent it on sign-in.
  void adoptServerCurrency(String? code) {
    final c = DominantCurrency.parse(code);
    if (c != null) setDominant(c);
  }

  Future<void> refresh() async {
    // Kept for callers that refresh all app services together.
  }

  double ngnToUsdc(double ngn) => ngn / _usdRates['NGN']!;
  double usdcToNgn(double usdc) => usdc * _usdRates['NGN']!;
  double eurToUsdc(double eur) => eur / _usdRates['EUR']!;
  double usdcToEur(double usdc) => usdc * _usdRates['EUR']!;
  double eurToNgn(double eur) => eurToUsdc(eur) * _usdRates['NGN']!;
  double ngnToEur(double ngn) => usdcToEur(ngnToUsdc(ngn));

  /// Dollars (USDC) for an amount typed in the dominant currency. Kept to
  /// USDC's six decimals, so ₦5,000 comes back as ₦5,000.00, not ₦5,004.
  double toUsd(double typed) {
    if (!isNaira) return typed;
    return (ngnToUsdc(typed) * 1e6).roundToDouble() / 1e6;
  }

  /// A dollar amount in the dominant currency, as a number.
  double fromUsd(double usd) => isNaira ? usdcToNgn(usd) : usd;

  /// A dollar amount in the dominant currency: "₦2,500.00" or "$1.80".
  String primary(double usd) =>
      isNaira ? formatNgn(usdcToNgn(usd)) : formatUsd(usd);

  /// The same amount in the other currency, for the line underneath.
  String secondary(double usd) =>
      isNaira ? formatUsd(usd) : formatNgn(usdcToNgn(usd));

  /// A token amount the way the person reads it: dollars in the dominant
  /// currency; euros stay euros (they are a separate balance).
  String primaryToken(double amount, String token) {
    if (token.toUpperCase() == 'EURC') return formatEur(amount);
    if (token.toUpperCase() == 'CIRBTC') return formatMoney(amount, token);
    return primary(amount);
  }

  /// The line under [primaryToken]: the other currency, or naira for euros.
  String secondaryToken(double amount, String token) {
    if (token.toUpperCase() == 'EURC') {
      return isNaira ? formatNgn(eurToNgn(amount)) : formatUsd(eurToUsdc(amount));
    }
    if (token.toUpperCase() == 'CIRBTC') return '';
    return secondary(amount);
  }

  /// A request's amount for this person. Asked for in their own currency, it
  /// shows exactly what was typed; otherwise the dollar total is converted.
  String requestPrimary({
    required double usd,
    String token = 'USDC',
    String? displayCurrency,
    double? displayAmount,
  }) {
    if (token.toUpperCase() != 'USDC') return primaryToken(usd, token);
    final asked = DominantCurrency.parse(displayCurrency);
    if (asked == dominant && displayAmount != null && displayAmount > 0) {
      return asked == DominantCurrency.ngn
          ? formatNgn(displayAmount)
          : formatUsd(displayAmount);
    }
    return primary(usd);
  }

  String liveRateLine() {
    final n = _usdRates['NGN']!.toStringAsFixed(0);
    return '1 USD = ₦$n';
  }
}
