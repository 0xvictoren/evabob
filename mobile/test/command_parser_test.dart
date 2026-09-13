import 'package:flutter_test/flutter_test.dart';
import 'package:evabob_mobile/core/chat/command_parser.dart';

void main() {
  test('parses naira send with description', () {
    final c = parseSendCommand(
      '@. send 3500 naira with description food',
    );
    expect(c, isNotNull);
    expect(c!.amount, 3500);
    expect(c.currency, 'ngn');
    expect(c.description.toLowerCase(), contains('food'));
  });

  test('parses eur amount', () {
    final c = parseSendCommand('@. send 50 eur for dinner');
    expect(c, isNotNull);
    expect(c!.amount, 50);
    expect(c.currency, 'eur');
  });

  test('looksLikeSendCommand', () {
    expect(looksLikeSendCommand('@. send 10'), isTrue);
    expect(looksLikeSendCommand('hello'), isFalse);
  });

  test('parses buy / swap App Kit command', () {
    final c = parseMoneyCommand('@. buy 10 usdc to eurc');
    expect(c, isNotNull);
    expect(c!.action, 'buy');
    expect(c.amount, 10);
    expect(c.tokenIn, 'USDC');
    expect(c.tokenOut, 'EURC');
  });

  test('parses bridge command', () {
    final c = parseMoneyCommand('@. bridge 25 to base');
    expect(c, isNotNull);
    expect(c!.action, 'bridge');
    expect(c.amount, 25);
    expect(c.toChain, 'Base_Sepolia');
  });

  test('looksLikeMoneyCommand', () {
    expect(looksLikeMoneyCommand('@. buy 1 usdc eurc'), isTrue);
    expect(looksLikeMoneyCommand('@. bridge 2 base'), isTrue);
    expect(looksLikeMoneyCommand('@. send 1'), isFalse);
  });

  test('parseSendIntent strict @. commands', () {
    final a = parseSendIntent('@. send 5 USDC');
    expect(a.intent, 'send');
    expect(a.amount, 5);
    expect(a.asset, 'USDC');
    expect(a.chain, 'Arc');
    expect(a.toType, 'thread');
    expect(a.needsConfirmation, isTrue);
    expect(a.confidence, greaterThanOrEqualTo(0.9));

    expect(parseSendIntent('@. send 5 USDC from Base').chain, 'Base');
    expect(parseSendIntent('@. send 5 USDC from Ethereum').chain, 'Ethereum');

    final phone = parseSendIntent('@. send 5 USDC to +2348012345678');
    expect(phone.intent, 'clarification_needed');

    final email = parseSendIntent('@. send 5 USDC to john@gmail.com');
    expect(email.toType, 'email');
    expect(email.to, 'john@gmail.com');
  });

  test('parseSendIntent natural language', () {
    final r = parseSendIntent('send 10 eurc to john');
    expect(r.intent, 'send');
    expect(r.amount, 10);
    expect(r.asset, 'EURC');
    expect(r.to, '@john');
    expect(r.toType, 'handle');
    expect(r.chain, 'Arc');
  });

  test('parseSendIntent unclear message', () {
    final r = parseSendIntent('hello');
    expect(r.intent, 'clarification_needed');
    expect(r.confidence, lessThan(0.5));
  });

  test('parseSendIntent dollar sign is USDC', () {
    final r = parseSendIntent(r'send $3 to @john');
    expect(r.intent, 'send');
    expect(r.amount, 3);
    expect(r.asset, 'USDC');
    expect(r.to, '@john');
  });
}
