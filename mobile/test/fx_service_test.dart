import 'package:evabob_mobile/core/fx/fx_service.dart';
import 'package:evabob_mobile/core/utils/money_format.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('rough built-in rates are used until the server has answered', () {
    final fx = FxService();
    expect(fx.sourceKind, FxSource.fallback);
    expect(fx.usdToNgn, 1390);
    expect(fx.usdcToNgn(2), 2780);
    expect(fx.ngnToUsdc(2780), 2);
  });

  test('the server rate replaces the built-in one everywhere at once', () {
    final fx = FxService();
    expect(
      fx.adoptServerRates({
        'source': 'live',
        'updatedAt': '2026-11-12T00:02:31.000Z',
        'rates': {'USD': 1, 'NGN': 1500, 'GHS': 12.5, 'EUR': 0.9},
      }),
      isTrue,
    );
    expect(fx.sourceKind, FxSource.live);
    expect(fx.usdToNgn, 1500);
    expect(fx.primary(2), '₦3,000.00');
    expect(formatMoney(2), '₦3,000.00');
    expect(fx.toUsd(3000), 2);
    expect(fx.liveRateLine(), '1 USD = ₦1,500');
    expect(fx.updatedAt, DateTime.parse('2026-11-12T00:02:31.000Z'));
  });

  test('a useless answer, or a server still on rough figures, changes nothing',
      () {
    final fx = FxService();
    fx.adoptServerRates({
      'source': 'live',
      'rates': {'NGN': 1500},
    });
    expect(fx.adoptServerRates({'source': 'live', 'rates': {'NGN': 0}}),
        isFalse);
    expect(fx.adoptServerRates({'source': 'live'}), isFalse);
    expect(
      fx.adoptServerRates({
        'source': 'fallback',
        'rates': {'NGN': 1390},
      }),
      isFalse,
    );
    expect(fx.usdToNgn, 1500);
  });

  test('naira typed is sent as its dollar amount, and reads back exactly', () {
    final fx = FxService();
    expect(fx.isNaira, isTrue);
    final usd = fx.toUsd(5000);
    expect(usd, closeTo(3.597122, 1e-6));
    expect(fx.primary(usd), '₦5,000.00');
    expect(fx.secondary(usd), r'$3.60');
  });

  test('any chosen currency is the one shown, typed and offered', () {
    final fx = FxService();
    fx.adoptServerRates({
      'source': 'live',
      'rates': {'NGN': 1500, 'GHS': 12.5, 'UGX': 3600, 'GBP': 0.8},
    });

    fx.dominant = DominantCurrency.parse('ghs')!;
    expect(fx.isNaira, isFalse);
    expect(fx.isDollar, isFalse);
    expect(fx.primary(2), 'GH₵25.00');
    expect(fx.secondary(2), r'$2.00');
    expect(formatMoney(2), 'GH₵25.00');
    expect(fx.toUsd(25), 2);
    expect(fx.fromUsd(2), 25);
    expect(fx.inputDecimals, 2);
    expect(fx.quickAmounts, ['100', '500', '1000']);
    expect(fx.liveRateLine(), '1 USD = GH₵12.50');

    fx.dominant = DominantCurrency.parse('UGX')!;
    expect(fx.primary(1), 'USh3,600.00');
    expect(fx.inputDecimals, 0);
    expect(fx.quickAmounts, ['5000', '20000', '50000']);

    fx.dominant = DominantCurrency.usd;
    expect(fx.primary(2), r'$2.00');
    expect(formatMoney(2), r'$2.00');
    expect(fx.toUsd(20), 20);
    expect(fx.secondary(2), '₦3,000.00');

    expect(DominantCurrency.parse('zzz'), isNull);
    fx.dominant = DominantCurrency.ngn;
  });

  test(
      'a request asked in naira reads exactly to a naira user, converted to anyone else',
      () {
    final fx = FxService();
    final usd = fx.toUsd(2500);
    expect(
      fx.requestPrimary(usd: usd, displayCurrency: 'NGN', displayAmount: 2500),
      '₦2,500.00',
    );
    fx.dominant = DominantCurrency.usd;
    expect(
      fx.requestPrimary(usd: usd, displayCurrency: 'NGN', displayAmount: 2500),
      r'$1.80',
    );
    fx.dominant = DominantCurrency.parse('KES')!;
    expect(
      fx.requestPrimary(usd: usd, displayCurrency: 'NGN', displayAmount: 2500),
      'KSh232.01',
    );
    fx.dominant = DominantCurrency.ngn;
  });
}
