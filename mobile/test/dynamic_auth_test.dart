import 'package:flutter_test/flutter_test.dart';
import 'package:evabob_mobile/core/auth/evabob_user.dart';

void main() {
  group('EvabobUser', () {
    test('displayNameFrom prefers username', () {
      expect(
        EvabobUser.displayNameFrom(
          username: 'victor',
          email: 'victor@example.com',
          phone: '+1',
        ),
        'victor',
      );
    });

    test('circleUserIdFrom is stable and circle-safe', () {
      final a = EvabobUser.circleUserIdFrom('Ada@Example.com');
      final b = EvabobUser.circleUserIdFrom('ada@example.com');
      expect(a, b, reason: 'case must not change the derived id');
      expect(a.length, greaterThanOrEqualTo(5));
      expect(RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(a), isTrue);
    });

    test('circleUserIdFrom hashes identifiers that are too long', () {
      final long = '${'a' * 60}@example.com';
      final id = EvabobUser.circleUserIdFrom(long);
      expect(id.length, lessThanOrEqualTo(40));
      expect(RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(id), isTrue);
      expect(id, EvabobUser.circleUserIdFrom(long));
    });
  });
}
