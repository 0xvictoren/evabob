import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../utils/money_format.dart';

/// The currency a person thinks in. Everything in the app is shown and typed
/// in it; money always moves as dollars (USDC) underneath.
@immutable
class DominantCurrency {
  const DominantCurrency(this.code, this.symbol, this.name, this.plural);

  final String code;
  final String symbol;

  /// As listed in the picker: "Naira", "Ghanaian cedi".
  final String name;

  /// As used in a sentence: "Price (naira)", "amounts typed in cedis".
  final String plural;

  static const ngn = DominantCurrency('NGN', '₦', 'Naira', 'naira');
  static const usd = DominantCurrency('USD', r'$', 'Dollar', 'dollars');

  /// Kept in step with the server's list (services/fx.ts).
  static const List<DominantCurrency> values = [
    ngn,
    usd,
    DominantCurrency('GHS', 'GH₵', 'Ghanaian cedi', 'cedis'),
    DominantCurrency('KES', 'KSh', 'Kenyan shilling', 'Kenyan shillings'),
    DominantCurrency('ZAR', 'R', 'South African rand', 'rand'),
    DominantCurrency('XOF', 'CFA', 'West African CFA franc', 'CFA francs'),
    DominantCurrency('XAF', 'FCFA', 'Central African CFA franc', 'CFA francs'),
    DominantCurrency('UGX', 'USh', 'Ugandan shilling', 'Ugandan shillings'),
    DominantCurrency('TZS', 'TSh', 'Tanzanian shilling', 'Tanzanian shillings'),
    DominantCurrency('RWF', 'FRw', 'Rwandan franc', 'Rwandan francs'),
    DominantCurrency('EGP', 'E£', 'Egyptian pound', 'Egyptian pounds'),
    DominantCurrency('GBP', '£', 'British pound', 'pounds'),
    DominantCurrency('EUR', '€', 'Euro', 'euros'),
    DominantCurrency('CAD', r'CA$', 'Canadian dollar', 'Canadian dollars'),
    DominantCurrency('AED', 'AED ', 'UAE dirham', 'dirhams'),
    DominantCurrency('INR', '₹', 'Indian rupee', 'rupees'),
  ];

  static DominantCurrency? parse(String? code) {
    final wanted = (code ?? '').trim().toUpperCase();
    for (final c in values) {
      if (c.code == wanted) return c;
    }
    return null;
  }

  @override
  bool operator ==(Object other) =>
      other is DominantCurrency && other.code == code;

  @override
  int get hashCode => code.hashCode;

  @override
  String toString() => code;
}

/// Where the rates in use came from.
///
///   live      fetched from the server in this session
///   saved     the last ones this phone fetched, from an earlier session
///   fallback  rough built-in figures, until the server has answered once
enum FxSource { live, saved, fallback }

/// Converts between dollars (USDC, what moves) and the currency a person
/// chose (what they see and type).
///
/// Rates come from the server, which refreshes them from a public feed. They
/// are remembered on the phone, so the app opens with the last known rate and
/// replaces it as soon as the server answers. A rate only changes what is
/// shown: the amount that moves is always worked out in dollars.
class FxService extends ChangeNotifier {
  FxService() {
    dominant = DominantCurrency.ngn;
  }

  static const _prefDominant = 'evabob_dominant_currency_v1';
  static const _prefRates = 'evabob_fx_rates_v1';
  static const _refreshEvery = Duration(hours: 1);

  /// Rough figures used only until the server has answered once.
  final Map<String, double> _usdRates = {
    'USD': 1.0,
    'USDC': 1.0,
    'NGN': 1390.0,
    'GHS': 12.0,
    'KES': 129.0,
    'ZAR': 17.5,
    'XOF': 565.0,
    'XAF': 565.0,
    'UGX': 3600.0,
    'TZS': 2500.0,
    'RWF': 1450.0,
    'EGP': 48.0,
    'GBP': 0.75,
    'EUR': 0.87,
    'CAD': 1.38,
    'AED': 3.6725,
    'INR': 88.0,
  };

  Future<Map<String, dynamic>> Function()? _fetch;
  Timer? _timer;
  DateTime? _updatedAt;
  FxSource _source = FxSource.fallback;

  /// When the rates in use were published; null for the built-in figures.
  DateTime? get updatedAt => _updatedAt;
  FxSource get sourceKind => _source;
  String get source => _source.name;

  double get usdToNgn => _usdRates['NGN']!;
  double get usdToEur => _usdRates['EUR']!;

  /// Units of the chosen currency for one dollar.
  double get rate => _usdRates[_dominant.code] ?? 1.0;

  /// Naira unless the person chose another.
  DominantCurrency _dominant = DominantCurrency.ngn;
  DominantCurrency get dominant => _dominant;
  set dominant(DominantCurrency value) {
    _dominant = value;
    _syncDisplay();
  }

  bool get isNaira => _dominant == DominantCurrency.ngn;
  bool get isDollar => _dominant == DominantCurrency.usd;

  /// Decimals worth typing: none where one unit is worth very little.
  int get inputDecimals => rate >= 50 ? 0 : 2;

  /// Every dollar amount shown through [formatMoney] follows the choice.
  void _syncDisplay() {
    moneyDisplayRate = isDollar ? null : rate;
    moneyDisplaySymbol = _dominant.symbol;
  }

  /// Where rates are fetched from: the server's `/v1/fx/rates`.
  void attach(Future<Map<String, dynamic>> Function() fetch) => _fetch = fetch;

  /// Reads the choice and the last rates saved on this phone, then asks the
  /// server for fresh ones now and every hour while the app is open.
  void start() {
    SharedPreferences.getInstance().then((prefs) {
      var changed = false;
      try {
        final saved = prefs.getString(_prefRates);
        if (saved != null && _source == FxSource.fallback) {
          final j = jsonDecode(saved) as Map<String, dynamic>;
          if (_adoptRates(j['rates'], j['updatedAt']?.toString())) {
            _source = FxSource.saved;
            changed = true;
          }
        }
      } catch (_) {/* a bad saved value is simply not used */}
      final c = DominantCurrency.parse(prefs.getString(_prefDominant));
      if (c != null && c != dominant) {
        dominant = c;
        changed = true;
      }
      _syncDisplay();
      if (changed) notifyListeners();
    }).catchError((_) {});
    unawaited(refresh());
    _timer ??= Timer.periodic(_refreshEvery, (_) => refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  /// Takes a `{code: unitsPerDollar}` map. True when the naira rate (the one
  /// most people here depend on) was in it and usable.
  bool _adoptRates(Object? rates, String? updatedAt) {
    if (rates is! Map) return false;
    final ngn = rates['NGN'];
    if (ngn is! num || ngn <= 0) return false;
    for (final e in rates.entries) {
      final v = e.value;
      if (v is num && v > 0 && v.isFinite) {
        _usdRates[e.key.toString().toUpperCase()] = v.toDouble();
      }
    }
    _usdRates['USD'] = 1.0;
    _usdRates['USDC'] = 1.0;
    _updatedAt = DateTime.tryParse(updatedAt ?? '') ?? _updatedAt;
    _syncDisplay();
    return true;
  }

  /// Rates as the server sent them. Public so a test can feed them in.
  bool adoptServerRates(Map<String, dynamic> res) {
    // A server that has never reached its feed sends its own rough figures;
    // ours from an earlier session are better than those.
    if (res['source'] == 'fallback' && _source != FxSource.fallback) {
      return false;
    }
    if (!_adoptRates(res['rates'], res['updatedAt']?.toString())) return false;
    _source = res['source'] == 'fallback' ? FxSource.fallback : FxSource.live;
    notifyListeners();
    return true;
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

  /// Asks the server for today's rates. Quietly keeps the ones in use when
  /// it cannot be reached: a rate must never stop the app working.
  Future<void> refresh() async {
    final fetch = _fetch;
    if (fetch == null) return;
    try {
      final res = await fetch();
      if (!adoptServerRates(res)) return;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _prefRates,
        jsonEncode({
          'rates': res['rates'],
          'updatedAt': res['updatedAt'],
        }),
      );
    } catch (_) {}
  }

  double ngnToUsdc(double ngn) => ngn / _usdRates['NGN']!;
  double usdcToNgn(double usdc) => usdc * _usdRates['NGN']!;
  double eurToUsdc(double eur) => eur / _usdRates['EUR']!;
  double usdcToEur(double usdc) => usdc * _usdRates['EUR']!;
  double eurToNgn(double eur) => eurToUsdc(eur) * _usdRates['NGN']!;
  double ngnToEur(double ngn) => usdcToEur(ngnToUsdc(ngn));

  /// An amount in the chosen currency, with its symbol: "₦2,500.00".
  String format(double amount) => formatCurrency(amount, _dominant.symbol);

  /// Dollars (USDC) for an amount typed in the dominant currency. Kept to
  /// USDC's six decimals, so ₦5,000 comes back as ₦5,000.00, not ₦5,004.
  double toUsd(double typed) {
    if (isDollar) return typed;
    return (typed / rate * 1e6).roundToDouble() / 1e6;
  }

  /// A dollar amount in the dominant currency, as a number.
  double fromUsd(double usd) => isDollar ? usd : usd * rate;

  /// A dollar amount in the dominant currency: "₦2,500.00" or "$1.80".
  String primary(double usd) => isDollar ? formatUsd(usd) : format(usd * rate);

  /// The same amount in the other currency, for the line underneath: dollars
  /// under a local currency, naira under dollars.
  String secondary(double usd) =>
      isDollar ? formatNgn(usdcToNgn(usd)) : formatUsd(usd);

  /// A token amount the way the person reads it: dollars in the dominant
  /// currency; euros stay euros (they are a separate balance).
  String primaryToken(double amount, String token) {
    if (token.toUpperCase() == 'EURC') return formatEur(amount);
    if (token.toUpperCase() == 'CIRBTC') return formatMoney(amount, token);
    return primary(amount);
  }

  /// The line under [primaryToken]: the other currency, or the person's own
  /// for euros.
  String secondaryToken(double amount, String token) {
    if (token.toUpperCase() == 'EURC') {
      final usd = eurToUsdc(amount);
      return isDollar || _dominant.code == 'EUR'
          ? formatUsd(usd)
          : format(usd * rate);
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
      return isDollar ? formatUsd(displayAmount) : format(displayAmount);
    }
    return primary(usd);
  }

  /// Round amounts worth offering as one-tap chips, in the chosen currency.
  List<String> get quickAmounts {
    if (isDollar || rate < 5) return const ['20', '50', '100'];
    if (rate < 50) return const ['100', '500', '1000'];
    if (rate < 2000) return const ['1000', '5000', '10000'];
    return const ['5000', '20000', '50000'];
  }

  /// "1 USD = ₦1,432", or nothing to say when the choice is dollars.
  String liveRateLine() {
    final c = isDollar ? DominantCurrency.ngn : _dominant;
    final r = _usdRates[c.code] ?? 1.0;
    final n = r >= 50 ? formatWhole(r) : r.toStringAsFixed(2);
    return '1 USD = ${c.symbol}$n';
  }
}
