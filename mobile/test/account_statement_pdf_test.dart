import 'dart:convert';

import 'package:evabob_mobile/features/profile/account_statement_pdf.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the account statement PDF builds from a real-shaped export', () async {
    final bytes = await buildAccountStatementPdf({
      'exportedAt': '2026-09-28T10:00:00.000Z',
      'profile': {
        'displayName': 'Ada 🚀 Obi',
        'handle': 'ada',
        'email': 'ada@example.com',
        'evmAddress': '0x' + 'a' * 40,
        'createdAt': '2026-09-01T09:00:00.000Z',
      },
      'activity': [
        for (var i = 0; i < 80; i++)
          {
            'kind': i.isEven ? 'send' : 'receive',
            'title': i.isEven ? 'Sent' : 'Received',
            'description': 'please I need payment for my goods ₦2,000 — “thanks”',
            'amountUsdc': i.isEven ? -1.44 : 3.8,
            'token': i % 5 == 0 ? 'EURC' : 'USDC',
            'counterparty': '@ekuma',
            'status': 'completed',
            'createdAt': '2026-09-25T21:0${i % 10}:00.000Z',
          },
      ],
      'contacts': [
        {'name': 'Chidi 😀', 'handle': '@chidi', 'email': 'chidi@example.com'},
      ],
      'chats': {'threads': [{}, {}], 'messages': [{}, {}, {}]},
      'limitations': ['Public blockchain records cannot be erased.'],
    });
    expect(ascii.decode(bytes.sublist(0, 5)), '%PDF-');
    expect(bytes.length, greaterThan(2000));
  });

  test('an empty export still makes a PDF', () async {
    final bytes = await buildAccountStatementPdf({});
    expect(ascii.decode(bytes.sublist(0, 5)), '%PDF-');
  });
}
