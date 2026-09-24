import 'package:evabob_mobile/core/navigation/app_link_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the account-recovery alert link opens in the app', () {
    final uri = AppLinkService.validated(
      Uri.parse('evabob://account-recovery/5b7f2c1e-9a0d-4f3e-8c1b-2d6a7e9f0a11'),
    );
    expect(uri, isNotNull);
    expect(uri!.host, 'account-recovery');
    expect(uri.pathSegments, ['5b7f2c1e-9a0d-4f3e-8c1b-2d6a7e9f0a11']);
  });

  test('a recovery link without an id is rejected', () {
    expect(
      AppLinkService.validated(Uri.parse('evabob://account-recovery')),
      isNull,
    );
  });

  test('unknown routes and odd ids are still rejected', () {
    expect(AppLinkService.validated(Uri.parse('evabob://steal/1')), isNull);
    expect(
      AppLinkService.validated(Uri.parse('evabob://account-recovery/a b')),
      isNull,
    );
  });
}
