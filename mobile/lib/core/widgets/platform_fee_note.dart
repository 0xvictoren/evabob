import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../config/app_features.dart';
import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';
import '../utils/money_format.dart';

/// "Evabob fee · $0.05 — you pay $100.05", shown above a confirm button.
///
/// The fee is added on top of [amount] and charged in the same PIN as the
/// payment. Renders nothing when the fee is off or rounds to zero, so screens
/// can place it unconditionally.
class PlatformFeeNote extends StatelessWidget {
  const PlatformFeeNote({
    super.key,
    required this.amount,
    this.token = 'USDC',
    this.decimals = 6,
    this.padding = const EdgeInsets.only(bottom: 12),
  });

  final double amount;
  final String token;
  final int decimals;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final features = context.watch<AppFeatures>();
    final fee = features.platformFeeFor(amount, decimals: decimals);
    if (fee <= 0) return const SizedBox.shrink();
    final percent = (features.platformFeeBps / 100)
        .toStringAsFixed(2)
        .replaceFirst(RegExp(r'0+$'), '')
        .replaceFirst(RegExp(r'\.$'), '');
    return Padding(
      padding: padding,
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Evabob fee ($percent%)',
              style: Type.label.copyWith(color: EvabobColors.inkMuted),
            ),
          ),
          Text(
            '${formatMoney(fee, token)} · you pay ${formatMoney(amount + fee, token)}',
            style: Type.label.copyWith(color: EvabobColors.ink),
          ),
        ],
      ),
    );
  }
}
