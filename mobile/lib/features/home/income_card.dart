import 'package:flutter/material.dart';

import '../../core/activity/activity_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/widgets/motion.dart';

class IncomeCard extends StatelessWidget {
  const IncomeCard({super.key, required this.activity});

  final ActivityService activity;

  @override
  Widget build(BuildContext context) {
    final series = _incomeSeries(activity.items);
    final total = series.fold<double>(0, (sum, value) => sum + value);
    final count = activity.items.where((entry) {
      return entry.positive &&
          _isDollars(entry) &&
          DateTime.now().difference(entry.createdAt).inDays < 7;
    }).length;

    return Column(
      children: [
        Row(
          children: [
            Text('Money in', style: Type.title),
            const Spacer(),
            Text(
              'Last 7 days',
              style: Type.body.copyWith(color: EvabobColors.inkTertiary),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          height: 150,
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 16),
          decoration: const BoxDecoration(
            color: EvabobColors.white,
            borderRadius: BorderRadius.all(Radius.circular(12)),
            boxShadow: Shadows.card,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    CountUp(
                      total,
                      builder: (_, value) => Text(
                        formatMoney(value),
                        maxLines: 1,
                        overflow: TextOverflow.fade,
                        style: Type.title,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      count == 1
                          ? 'You got paid once'
                          : 'You got paid $count times',
                      style: Type.label.copyWith(color: EvabobColors.inkMuted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: 166,
                child: _Bars(values: series),
              ),
            ],
          ),
        ),
      ],
    );
  }

  static List<double> _incomeSeries(List<ActivityEntry> items) {
    final now = DateTime.now();
    final buckets = List<double>.filled(7, 0);
    for (final entry in items) {
      if (!entry.positive || entry.isPending || !_isDollars(entry)) continue;
      final days = now.difference(entry.createdAt).inDays;
      if (days < 0 || days >= 7) continue;
      buckets[6 - days] += entry.displayAmount;
    }
    return buckets;
  }

  /// The card is labelled in dollars, so euro (and any other token) receipts
  /// must not be summed into it at face value.
  static bool _isDollars(ActivityEntry entry) {
    final token = entry.displayToken.toUpperCase();
    return token.isEmpty || token == 'USDC' || token == 'USD';
  }
}

class _Bars extends StatelessWidget {
  const _Bars({required this.values});

  final List<double> values;

  @override
  Widget build(BuildContext context) {
    final max = values.fold<double>(0, (a, b) => a > b ? a : b);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (var i = 0; i < values.length; i++)
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(left: i == 0 ? 0 : 5),
              child: AnimatedContainer(
                duration: Motion.base,
                curve: Motion.smooth,
                height: max == 0 ? 10 : 10 + 74 * (values[i] / max),
                decoration: BoxDecoration(
                  color: i == values.length - 1
                      ? EvabobColors.blue
                      : EvabobColors.lightDark,
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(4),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
