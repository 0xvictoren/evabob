import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/utils/text_safe.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/utils/money_format.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/confirm_action_dialog.dart';
import '../../core/widgets/glass.dart';

/// Money this user is holding for someone else, with a way to hand it over.
///
/// It needs its own list rather than riding on activity rows because releasing
/// takes the on-chain transfer id, which an activity row does not carry.
class HeldPaymentsBanner extends StatefulWidget {
  const HeldPaymentsBanner({super.key});

  @override
  State<HeldPaymentsBanner> createState() => _HeldPaymentsBannerState();
}

class _HeldPaymentsBannerState extends State<HeldPaymentsBanner> {
  List<Map<String, dynamic>> _items = const [];
  String? _busyId;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await context.read<CircleWalletService>().listHeldPayments();
      if (!mounted) return;
      setState(() {
        _items = list;
        _loaded = true;
      });
    } catch (_) {
      if (mounted) setState(() => _loaded = true);
    }
  }

  /// Days left, because an exact timestamp is not what anyone needs here —
  /// they need to know whether it is about to come back to them.
  String _remaining(String? expiresAt) {
    if (expiresAt == null) return '';
    final end = DateTime.tryParse(expiresAt);
    if (end == null) return '';
    final left = end.difference(DateTime.now());
    if (left.isNegative) return 'expired — returning to you';
    if (left.inDays >= 1) {
      return '${left.inDays} day${left.inDays == 1 ? '' : 's'} left';
    }
    return '${left.inHours} hour${left.inHours == 1 ? '' : 's'} left';
  }

  Future<void> _release(Map<String, dynamic> item) async {
    final id = item['transferId']?.toString();
    if (id == null) return;
    // Handing the money over is final, and it sat behind a single unguarded
    // tap on a banner someone might not have been reading closely.
    final amount = (item['amountUsdc'] as num?)?.toDouble();
    final who = item['recipientId']?.toString() ?? 'them';
    final confirmed = await confirmAction(
      context,
      title: 'Send this to $who?',
      message: amount == null
          ? 'It reaches them straight away, and you cannot get it back '
              'afterwards.'
          : '${formatMoney(amount)} reaches them straight away. You cannot '
              'get it back afterwards.',
      confirmLabel: 'Send it',
    );
    if (!confirmed || !mounted) return;
    setState(() => _busyId = id);
    final circle = context.read<CircleWalletService>();
    final activity = context.read<ActivityService>();
    final wallet = context.read<WalletService>();
    final res = await circle.releaseHold(id);
    if (!mounted) return;
    setState(() => _busyId = null);

    final ok = res['ok'] == true;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          ok
              ? 'Sent to ${item['recipientId']}'
              : friendlyError(
                  res['error'],
                  fallback: 'Could not send that yet. Try again in a moment.',
                ),
        ),
        behavior: SnackBarBehavior.floating,
      ),
    );
    if (ok) {
      await _load();
      try {
        await activity.refresh();
        await wallet.refreshBalances(force: true, silent: true);
      } catch (_) {}
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded || _items.isEmpty) return const SizedBox.shrink();
    return Column(
      children: [
        for (final item in _items)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Glass(
              child: Row(
                children: [
                  CircleAvatar(
                    backgroundColor:
                        EvabobColors.danger.withValues(alpha: 0.12),
                    child: const Icon(
                      Icons.lock_clock_rounded,
                      color: EvabobColors.danger,
                      size: 20,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Holding ${item['amountUsdc'] is num ? formatMoney((item['amountUsdc'] as num).toDouble()) : '\$—'} for ${item['recipientId']}',
                          style: const TextStyle(
                            fontWeight: FontWeight.w400,
                            color: EvabobColors.navy,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          [
                            if ((item['memo']?.toString() ?? '').isNotEmpty)
                              item['memo'].toString(),
                            _remaining(item['expiresAt']?.toString()),
                          ].where((s) => s.isNotEmpty).join(' · '),
                          style: const TextStyle(
                            fontSize: 10,
                            color: EvabobColors.navyMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (_busyId == item['transferId']?.toString())
                    const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  else
                    FilledButton(
                      onPressed:
                          item['expired'] == true ? null : () => _release(item),
                      child: const Text('Send it'),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
