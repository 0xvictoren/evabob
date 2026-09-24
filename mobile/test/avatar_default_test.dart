import 'package:evabob_mobile/core/widgets/bundle_avatar.dart';
import 'package:flutter_test/flutter_test.dart';

// The server works out the same default picture (services/avatar.ts
// defaultAvatarBundle). If these drift, people see one picture of
// themselves and everyone else sees another.
void main() {
  test('default picture matches the server for the same account id', () {
    expect(deterministicAvatarIndex('user_abc'), 21);
    expect(deterministicAvatarIndex('ekuma-123'), 15);
    expect(
      deterministicAvatarIndex('0f3a9c1e-77aa-4b4b-9d2e-1c2b3a4d5e6f'),
      3,
    );
  });
}
