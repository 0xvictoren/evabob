// What a person is shown when something fails.
//
// Roughly fifteen places in the app rendered a caught exception directly, so
// a real failure reached the user as `ApiException(400): insufficient_balance`
// — an HTTP code, a class name and a machine token, none of which tell anyone
// what to do. These pin the two things that matter: nothing machine-shaped
// survives to the screen, and the failures that need specific advice get it.

import 'package:evabob_mobile/core/utils/text_safe.dart';
import 'package:flutter_test/flutter_test.dart';

class _ApiException implements Exception {
  _ApiException(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => 'ApiException($status): $message';
}

void main() {
  group('friendlyError', () {
    test('strips the ApiException wrapper and the machine token', () {
      final out = friendlyError(_ApiException(400, 'insufficient_balance'));
      expect(out, 'There is not enough in your balance for that.');
      expect(out, isNot(contains('400')));
      expect(out, isNot(contains('ApiException')));
    });

    test('strips a bare Exception prefix off copy written for a human', () {
      // agents_screen throws a well-written sentence, which then reached the
      // user with "Exception: " glued to the front of it.
      final out = friendlyError(
        Exception('The transfer went through but has not settled yet.'),
      );
      expect(out, 'The transfer went through but has not settled yet.');
    });

    test('tells someone offline what is actually wrong', () {
      final out = friendlyError(
        const TestSocketException('Failed host lookup: api.evabob.app'),
      );
      expect(out, contains('connection'));
      expect(out, isNot(contains('host lookup')));
    });

    test('does not tell someone to retry a payment that timed out', () {
      // A timeout is not a failure: retrying is how a person pays twice.
      final out = friendlyError(Exception('TimeoutException after 0:00:30'));
      expect(out, contains('Activity'));
      expect(out, isNot(contains('try again.')));
    });

    test('falls back rather than showing a bare snake_case token', () {
      expect(friendlyError('some_unmapped_code'),
          'Something went wrong. Please try again.');
    });

    test('falls back rather than showing a stack trace or a JSON body', () {
      expect(friendlyError('#0 main (file:///a.dart:1)'),
          'Something went wrong. Please try again.');
      expect(friendlyError('{"error":"nope"}'),
          'Something went wrong. Please try again.');
    });

    test('uses the caller fallback when there is a better one', () {
      expect(
        friendlyError('internal_server_thing',
            fallback: 'The payment did not go through.'),
        'The payment did not go through.',
      );
    });

    test('keeps a plain server sentence, capitalised', () {
      expect(friendlyError('to and amount required'), 'To and amount required');
    });

    test('handles null and empty without throwing', () {
      expect(friendlyError(null), 'Something went wrong. Please try again.');
      expect(friendlyError('   '), 'Something went wrong. Please try again.');
    });

    test('a server fault shows its reference so it can be found in the logs',
        () {
      expect(
        friendlyError(_ApiException(500, 'internal_error:AB12CD34')),
        'Something went wrong on our side. Please try again. (Ref AB12CD34)',
      );
    });
  });
}

/// Stands in for `dart:io`'s SocketException so the test does not need a real
/// socket to check the offline path.
class TestSocketException implements Exception {
  const TestSocketException(this.message);
  final String message;
  @override
  String toString() => 'SocketException: $message';
}
