import 'package:evabob_mobile/core/api/api_client.dart';
import 'package:evabob_mobile/core/config/app_features.dart';
import 'package:evabob_mobile/features/home/home_menu.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

void main() {
  AppFeatures everything() =>
      AppFeatures(ApiClient(baseUrl: 'http://127.0.0.1:1'))
        ..requests = true
        ..gateway = true
        ..conversion = true
        ..agentWallets = true
        ..bridgeRoutes = const ['Arc_Testnet:Base_Sepolia'];

  Future<HomeMenuAction?> Function() open(
      WidgetTester tester, AppFeatures features) {
    late BuildContext ctx;
    HomeMenuAction? picked;
    return () async {
      await tester.pumpWidget(
        ChangeNotifierProvider<AppFeatures>.value(
          value: features,
          child: MaterialApp(
            home: Builder(builder: (c) {
              ctx = c;
              return const Scaffold();
            }),
          ),
        ),
      );
      showHomeMenu(ctx).then((v) => picked = v);
      await tester.pumpAndSettle();
      return picked;
    };
  }

  // The order the product owner fixed, read across each row of the grid.
  const order = [
    'Request',
    'Sell with a link',
    'Circles and collections',
    'Get paid by agents',
    'Work for agents',
    'Convert',
    'Gateway Account',
    'Move money',
    'Agent wallets',
  ];

  testWidgets('the menu is a three-column grid in the fixed order',
      (tester) async {
    await open(tester, everything())();
    expect(tester.takeException(), isNull);
    final centers = [for (final l in order) tester.getCenter(find.text(l))];
    for (var i = 0; i < order.length; i++) {
      final row = i ~/ 3, col = i % 3;
      // Same row → same height; next column → further right.
      expect(centers[i].dy, closeTo(centers[row * 3].dy, 12), reason: order[i]);
      if (col > 0) {
        expect(centers[i].dx, greaterThan(centers[i - 1].dx), reason: order[i]);
      }
      if (row > 0) {
        expect(centers[i].dy, greaterThan(centers[i - 3].dy), reason: order[i]);
      }
    }
    // Never the abbreviation.
    expect(find.textContaining('GA'), findsNothing);
  });

  testWidgets('tapping a tile closes the menu with that choice',
      (tester) async {
    HomeMenuAction? picked;
    late BuildContext ctx;
    await tester.pumpWidget(
      ChangeNotifierProvider<AppFeatures>.value(
        value: everything(),
        child: MaterialApp(
          home: Builder(builder: (c) {
            ctx = c;
            return const Scaffold();
          }),
        ),
      ),
    );
    showHomeMenu(ctx).then((v) => picked = v);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Convert'));
    await tester.pumpAndSettle();
    expect(picked, HomeMenuAction.convert);
  });

  testWidgets('switched-off features leave no gaps, on a small phone',
      (tester) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final features = AppFeatures(ApiClient(baseUrl: 'http://127.0.0.1:1'));
    await open(tester, features)();
    expect(tester.takeException(), isNull);
    expect(find.text('Convert'), findsNothing);
    expect(find.text('Gateway Account'), findsNothing);
    expect(find.text('Sell with a link'), findsOneWidget);
    expect(find.text('Circles and collections'), findsOneWidget);
  });
}
