import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:evabob_mobile/main.dart';

void main() {
  testWidgets(
    'app can boot with an injected test surface',
    (tester) async {
      await tester.pumpWidget(
        const EvabobApp(homeOverride: Text('Evabob test surface')),
      );
      await tester.pump();
      expect(find.textContaining('Evabob'), findsWidgets);
    },
  );
}
