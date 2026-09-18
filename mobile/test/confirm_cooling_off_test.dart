import 'package:evabob_mobile/core/api/api_client.dart';
import 'package:evabob_mobile/core/config/app_features.dart';
import 'package:evabob_mobile/core/widgets/confirm_payment_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

/// The review sheet's cooling-off offer: on by default for a first payment to
/// someone new, and the choice comes back to the send screen.
void main() {
  Future<(BuildContext, AppFeatures)> boot(WidgetTester tester) async {
    late BuildContext ctx;
    final features = AppFeatures(ApiClient(baseUrl: 'http://127.0.0.1:1'));
    await tester.pumpWidget(
      ChangeNotifierProvider<AppFeatures>.value(
        value: features,
        child: MaterialApp(
          home: Builder(builder: (context) {
            ctx = context;
            return const Scaffold();
          }),
        ),
      ),
    );
    return (ctx, features);
  }

  testWidgets('a first payment offers to wait, switched on', (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 1400));
    final (ctx, _) = await boot(tester);
    PaymentChoice? choice;
    final done = confirmPaymentChoice(
      ctx,
      const PaymentReview(
        payee: 'Maya',
        amount: 5,
        firstTime: true,
        coolingOffMinutes: 10,
        coolingOffDefault: true,
      ),
    ).then((c) => choice = c);
    await tester.pumpAndSettle();

    expect(find.text('Wait 10 minutes before it goes'), findsOneWidget);
    expect(find.text('Send in 10 min'), findsOneWidget);

    // A first payment still needs the "right person" tick.
    await tester.tap(find.text('I have checked this is the right person.'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Send in 10 min'));
    await tester.pumpAndSettle();
    await done;
    expect(choice?.coolingOff, isTrue);
  });

  testWidgets('switching it off sends now', (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 1400));
    final (ctx, _) = await boot(tester);
    PaymentChoice? choice;
    final done = confirmPaymentChoice(
      ctx,
      const PaymentReview(
        payee: 'Maya',
        amount: 5,
        coolingOffMinutes: 10,
        coolingOffDefault: true,
      ),
    ).then((c) => choice = c);
    await tester.pumpAndSettle();

    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(find.text('Send \$5.00'), findsOneWidget);
    await tester.tap(find.text('Send \$5.00'));
    await tester.pumpAndSettle();
    await done;
    expect(choice?.coolingOff, isFalse);
  });

  testWidgets('no offer when the payee cannot be held for', (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 1400));
    final (ctx, _) = await boot(tester);
    confirmPaymentChoice(
      ctx,
      const PaymentReview(
        payee: '0x9999…8888',
        amount: 5,
        cautions: ['This address is not an Evabob account.'],
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(Switch), findsNothing);
    expect(find.text('This address is not an Evabob account.'), findsOneWidget);
  });
}
