import 'package:evabob_mobile/core/api/api_client.dart';
import 'package:evabob_mobile/core/config/app_features.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  AppFeatures features(int bps) =>
      AppFeatures(ApiClient(baseUrl: 'http://localhost'))..platformFeeBps = bps;

  test('0.05% of \$100 is \$0.05', () {
    expect(features(5).platformFeeFor(100), closeTo(0.05, 1e-12));
  });

  test('no minimum: a fee below one micro-unit is zero', () {
    expect(features(5).platformFeeFor(0.001), 0);
    expect(features(5).platformFeeFor(1), closeTo(0.0005, 1e-12));
  });

  test('matches the server for amounts with float drift', () {
    // 100.05 × 1e6 is 100049999.999… in floating point; the typed amount is
    // 100.05, so the fee must be computed from 100050000 units.
    expect(features(5).platformFeeFor(100.05), closeTo(0.050025, 1e-12));
  });

  test('off when the server reports no fee', () {
    expect(features(0).platformFeeFor(100), 0);
  });

  test('cirBTC uses its 8 decimals', () {
    expect(
      features(5).platformFeeFor(0.01, decimals: 8),
      closeTo(0.000005, 1e-12),
    );
  });
}
