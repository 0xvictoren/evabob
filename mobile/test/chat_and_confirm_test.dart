import 'package:evabob_mobile/core/chat/chat_models.dart';
import 'package:evabob_mobile/core/wallet/circle_native_sdk.dart';
import 'package:evabob_mobile/features/chat/request_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _card({bool open = true, String status = 'Request · unpaid'}) => {
      'type': 'invoice_card',
      'requestId': '594fc8d3-c021-40c7-8fef-a8e2dbc34f14',
      'token': 'USDC',
      'total': 5,
      'amount': 5,
      'open': open,
      'status': status,
      'items': [
        {'description': 'Jollof rice', 'amount': 3},
        {'description': 'Delivery', 'amount': 2},
      ],
    };

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: Center(child: child)));

void main() {
  testWidgets('the person asked sees every line, the total, Pay and Cancel', (t) async {
    var paid = false;
    var declined = false;
    await t.pumpWidget(_host(RequestCard(
      meta: _card(),
      mine: false,
      createdAt: DateTime(2026, 9, 19, 10),
      onPay: () => paid = true,
      onDecline: () => declined = true,
    )));
    expect(find.text('Jollof rice'), findsOneWidget);
    expect(find.text('Delivery'), findsOneWidget);
    expect(find.text('Total'), findsOneWidget);
    await t.tap(find.text('Pay'));
    await t.tap(find.text('Cancel'));
    expect(paid, isTrue);
    expect(declined, isTrue);
  });

  testWidgets('the person asking can only cancel their own request', (t) async {
    await t.pumpWidget(_host(RequestCard(
      meta: _card(),
      mine: true,
      createdAt: DateTime(2026, 9, 19, 10),
      onCancel: () {},
    )));
    expect(find.text('Pay'), findsNothing);
    expect(find.text('Cancel request'), findsOneWidget);
  });

  testWidgets('a declined request closes for both', (t) async {
    await t.pumpWidget(_host(RequestCard(
      meta: _card(open: false, status: 'Request · declined'),
      mine: false,
      createdAt: DateTime(2026, 9, 19, 10),
      onPay: () {},
      onDecline: () {},
    )));
    expect(find.text('Request · declined'), findsOneWidget);
    expect(find.text('Pay'), findsNothing);
  });

  test('a chat knows the other person\'s picture', () {
    final t = ChatThread.fromJson({
      'id': 't1',
      'title': 'maxxi',
      'handle': 'nzubechi_',
      'peerUserId': 'u2',
      'peerAvatarUrl': '/uploads/avatar_x.jpg',
      'peerAvatarBundle': 4,
    });
    expect(t.peerAvatarBundle, 4);
    expect(t.peerAvatarUrl, '/uploads/avatar_x.jpg');
    expect(t.copyWith(unread: 2).peerAvatarBundle, 4);
    expect(t.isAgent, isFalse);
  });

  test('native confirmation keeps only real signatures and knows a cancel', () {
    final ok = NativeConfirm.fromMap({'ok': true, 'signature': '0xabc'});
    expect(ok.ok, isTrue);
    expect(ok.signature, '0xabc');
    expect(NativeConfirm.fromMap({'ok': true, 'signature': 'nope'}).signature, isNull);
    final cancel = NativeConfirm.fromMap({'ok': false, 'canceled': true});
    expect(cancel.canceled, isTrue);
    expect(NativeConfirm.fromMap(null).ok, isFalse);
  });
}
