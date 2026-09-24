import 'package:intl/intl.dart';

final _ngn = NumberFormat.currency(
  locale: 'en_NG',
  symbol: '₦',
  decimalDigits: 2,
);

final _usd = NumberFormat.currency(
  locale: 'en_US',
  symbol: '\$',
  decimalDigits: 2,
);

final _eur = NumberFormat.currency(
  locale: 'en_EU',
  symbol: '€',
  decimalDigits: 2,
);

String formatNgn(double v, {bool compactSign = false}) {
  final s = _ngn.format(v.abs());
  if (compactSign) {
    if (v > 0) return '+$s';
    if (v < 0) return '−$s';
  }
  if (v < 0) return '−$s';
  return s;
}

String formatUsd(double v) => _usd.format(v);

/// Naira per dollar when the person's main currency is naira, else null.
///
/// Set by [FxService] when the choice changes. Every dollar amount shown
/// through [formatMoney] follows it, so the whole app switches at once rather
/// than screen by screen.
double? moneyDisplayNgnRate;
String formatEur(double v) => _eur.format(v);

/// An amount the way a person reads one: a currency symbol and two decimals.
///
/// [formatUsdc] appends a ticker, and because it is called from roughly thirty
/// places across the app it is single-handedly the largest source of crypto
/// vocabulary on screen. New code should use this instead; the old one stays
/// until every call site has moved.
String formatMoney(double v, [String token = 'USDC']) {
  switch (token.toUpperCase()) {
    case 'EURC':
      return _eur.format(v);
    case 'CIRBTC':
      return '₿${v.toStringAsFixed(6)}';
    default:
      final rate = moneyDisplayNgnRate;
      return rate != null ? formatNgn(v * rate) : _usd.format(v);
  }
}

/// Kept as an alias so the ~20 existing call sites did not all have to move
/// at once. It no longer appends the ticker: it was doing that on every screen
/// outside Home, which is most of the crypto vocabulary the app had left.
String formatUsdc(double v) => formatMoney(v);

/// The token amount itself — dollars as dollars — whatever the person's main
/// currency. For screens that move a specific token between networks (Move
/// money, Gateway, swaps), and for text stored where both people read it.
String formatTokenAmount(double v, [String token = 'USDC']) {
  switch (token.toUpperCase()) {
    case 'EURC':
      return _eur.format(v);
    case 'CIRBTC':
      return '₿${v.toStringAsFixed(6)}';
    default:
      return _usd.format(v);
  }
}
