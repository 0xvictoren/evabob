import 'package:evabob_mobile/core/config/env.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('API origin validation', () {
    test('accepts exact HTTPS origins', () {
      expect(Env.isHttpsOrigin('https://api.evabob.app'), isTrue);
      expect(Env.isHttpsOrigin('https://api.evabob.app:8443/'), isTrue);
    });

    test('rejects cleartext and non-origin URLs', () {
      expect(Env.isHttpsOrigin('http://192.168.1.20:8787'), isFalse);
      expect(Env.isHttpsOrigin('https://api.evabob.app/v1'), isFalse);
      expect(Env.isHttpsOrigin('https://user@api.evabob.app'), isFalse);
      expect(
          Env.isHttpsOrigin('https://api.evabob.app?redirect=evil'), isFalse);
      expect(Env.isHttpsOrigin('not a URL'), isFalse);
      expect(Env.isHttpsOrigin(''), isFalse);
    });
  });
}
