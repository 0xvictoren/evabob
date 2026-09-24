import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../features/activity/activity_screen.dart';
import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';

/// The receipt at the end of a money move (Figma "Request · Pay" 52:2381 and
/// "Convert · Done" 46:2204): a check, what happened, the amount, three facts,
/// then Done and a way to Activity.
class DoneReceiptScreen extends StatelessWidget {
  const DoneReceiptScreen({
    super.key,
    required this.title,
    required this.amount,
    this.sub,
    required this.rows,
  });

  final String title;

  /// Already formatted.
  final String amount;

  /// One line under the amount, such as "For rent" or "from $250.00".
  final String? sub;

  /// Label and value pairs for the card, top to bottom.
  final List<(String, String)> rows;

  static Future<void> open(
    BuildContext context, {
    required String title,
    required String amount,
    String? sub,
    required List<(String, String)> rows,
  }) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => DoneReceiptScreen(
          title: title,
          amount: amount,
          sub: sub,
          rows: rows,
        ),
      ),
    );
  }

  /// "9:41 today", or "3 Mar, 9:41" on another day.
  static String when(DateTime at) {
    final now = DateTime.now();
    final today =
        at.year == now.year && at.month == now.month && at.day == now.day;
    return today
        ? '${DateFormat('H:mm').format(at)} today'
        : DateFormat('d MMM, H:mm').format(at);
  }

  @override
  Widget build(BuildContext context) {
    final line = sub?.trim() ?? '';

    Widget row(String label, String value) => SizedBox(
          height: 56,
          child: Row(
            children: [
              Text(label, style: Type.body),
              const SizedBox(width: 16),
              Expanded(
                child: Text(
                  value,
                  textAlign: TextAlign.right,
                  overflow: TextOverflow.ellipsis,
                  style: Type.body.copyWith(color: EvabobColors.slate),
                ),
              ),
            ],
          ),
        );

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 76),
              Center(
                child: Container(
                  width: 88,
                  height: 88,
                  alignment: Alignment.center,
                  decoration: const BoxDecoration(
                    color: EvabobColors.white,
                    shape: BoxShape.circle,
                  ),
                  child: Image.asset(
                    'assets/figma/hero_check.png',
                    width: 36,
                    height: 36,
                    // One solid colour: drawn in the chosen theme's.
                    color: EvabobColors.blue,
                    colorBlendMode: BlendMode.srcIn,
                  ),
                ),
              ),
              const SizedBox(height: 32),
              Text(
                title,
                textAlign: TextAlign.center,
                style: Type.title.copyWith(
                  fontSize: 24,
                  height: 32 / 24,
                  letterSpacing: -0.4,
                ),
              ),
              const SizedBox(height: 12),
              FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(amount, style: Type.hero),
              ),
              if (line.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(
                  line,
                  textAlign: TextAlign.center,
                  style: Type.body.copyWith(color: EvabobColors.slate),
                ),
              ] else
                const SizedBox(height: 26),
              const SizedBox(height: 26),
              Container(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                decoration: const BoxDecoration(
                  color: EvabobColors.white,
                  borderRadius: BorderRadius.all(Radius.circular(12)),
                  boxShadow: [
                    BoxShadow(
                      color: Color(0x0F0B1620),
                      blurRadius: 24,
                      spreadRadius: -6,
                    ),
                  ],
                ),
                child: Column(
                  children: [
                    for (var i = 0; i < rows.length; i++) ...[
                      if (i > 0)
                        const Divider(height: 1, color: EvabobColors.hairline),
                      row(rows[i].$1, rows[i].$2),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Center(
                child: Image.asset('assets/logo.png', width: 20, height: 20),
              ),
              const SizedBox(height: 6),
              const Text(
                'EVABOB RECEIPT',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 10,
                  height: 14 / 10,
                  letterSpacing: .8,
                  color: EvabobColors.inkTertiary,
                ),
              ),
              const SizedBox(height: 20),
              DecoratedBox(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.all(Radius.circular(12)),
                  boxShadow: [
                    BoxShadow(
                      color: EvabobColors.buttonGlow,
                      blurRadius: 24,
                      spreadRadius: -6,
                    ),
                  ],
                ),
                child: SizedBox(
                  height: 56,
                  child: FilledButton(
                    onPressed: () => Navigator.of(context).pop(),
                    style: FilledButton.styleFrom(
                      backgroundColor: EvabobColors.blue,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: Text(
                      'Done',
                      style: Type.body.copyWith(color: EvabobColors.white),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              Center(
                child: GestureDetector(
                  onTap: () => Navigator.of(context).pushReplacement(
                    MaterialPageRoute<void>(
                      builder: (ctx) => Scaffold(
                        backgroundColor: EvabobColors.pageBg,
                        body: ActivityScreen(
                          onBack: () => Navigator.of(ctx).pop(),
                        ),
                      ),
                    ),
                  ),
                  child: Text(
                    'See it in Activity',
                    style: Type.body.copyWith(color: EvabobColors.blue),
                  ),
                ),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}
