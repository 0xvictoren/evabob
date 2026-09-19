import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:evabob_mobile/core/api/api_client.dart';
import 'package:evabob_mobile/core/auth/evabob_auth.dart';

ApiClient clientAnswering(int status, Map<String, dynamic> body) => ApiClient(
      baseUrl: 'http://api.test',
      client: MockClient(
        (_) async => http.Response(jsonEncode(body), status),
      ),
    );

void main() {
  group('when a sign-in has ended', () {
    test('an expired-session answer tells the app once and does not retry',
        () async {
      final api = clientAnswering(401, {
        'error': 'session_expired',
        'code': 'SESSION_EXPIRED',
        'detail': 'Your sign-in has ended. Sign in again to carry on.',
      });
      var told = 0;
      api.onSessionExpired = () => told++;
      await expectLater(
        api.get('/v1/activity'),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 401)
            .having((e) => e.message, 'message', contains('Sign in again'))),
      );
      expect(told, 1);
    });

    test('any other 401 is not treated as an ended sign-in', () async {
      final api = clientAnswering(401, {'error': 'unauthorized'});
      var told = 0;
      api.onSessionExpired = () => told++;
      await expectLater(api.get('/v1/activity'), throwsA(isA<ApiException>()));
      expect(told, 0);
    });

    test('the sign-in service listens for it, and ignores it when signed out',
        () async {
      final api = clientAnswering(200, {});
      final auth = EvabobAuth(api: api);
      expect(api.onSessionExpired, isNotNull);
      // Nobody is signed in: nothing to end, and nothing breaks.
      api.onSessionExpired!();
      await Future<void>.delayed(Duration.zero);
      expect(auth.sessionEndedEmail, isNull);
      expect(auth.sessionExpired, isFalse);
    });
  });
}
