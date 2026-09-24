import 'package:evabob_mobile/core/fx/fx_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('uses the fixed product USD to NGN rate', () {
    final fx = FxService();

    expect(fx.usdToNgn, 1390);
    expect(fx.usdcToNgn(2), 2780);
    expect(fx.ngnToUsdc(2780), 2);
    expect(fx.source, 'fixed');
  });

  test('naira typed is sent as its dollar amount, and reads back exactly', () {
    final fx = FxService();
    expect(fx.isNaira, isTrue);
    final usd = fx.toUsd(5000);
    expect(usd, closeTo(3.597122, 1e-6));
    expect(fx.primary(usd), '₦5,000.00');
    expect(fx.secondary(usd), r'$3.60');
  });

  test('a request asked in naira reads exactly to a naira user, converted to a dollar user', () {
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
    expect(fx.toUsd(20), 20);
    fx.dominant = DominantCurrency.ngn;
  });
}
