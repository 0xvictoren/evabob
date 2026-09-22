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
}
