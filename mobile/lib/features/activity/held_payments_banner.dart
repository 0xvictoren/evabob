import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/held/held_payments_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/utils/money_format.dart';
import '../../core/widgets/glass.dart';
import '../held/held_payment_screen.dart';

/// Money being held — for someone, or for this person — that is not settled.
///
/// Both sides see it now. A worker used to have no view of money held for
/// them at all, so they could not mark work delivered, and a payer who went
/// quiet simply got it back at expiry. Each row says in one line where the
/// payment stands and opens the payment for anything that needs doing.
class HeldPaymentsBanner extends StatefulWidget {
  const HeldPaymentsBanner({super.key});

  @override
  State<HeldPaymentsBanner> createState() => _HeldPaymentsBannerState();
}

class _HeldPaymentsBannerState extends State<HeldPaymentsBanner> {
  List<HeldPayment> _items = const [];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final all = await HeldPaymentsApi(context.read<ApiClient>()).list();
      if (!mounted) return;
      setState(() {
        _items = all.where((h) => !h.stage.settled).toList(growable: false);
        _loaded = true;
      });
    } catch (_) {
      if (mounted) setState(() => _loaded = true);
    }
  }

  Future<void> _open(HeldPayment h) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => HeldPaymentScreen(transferId: h.transferId),
      ),
    );
    if (mounted) await _load();
  }

  String _line(HeldPayment h) {
    String day(DateTime? t) =>
        t == null ? 'soon' : DateFormat('d MMM').format(t.toLocal());
    final who = h.counterparty;
    return switch (h.stage) {
      HeldStage.waitingForDelivery => h.isPayer
          ? 'Held for $who until the work arrives'
          : '$who is holding this for your work — mark it delivered when done',
      HeldStage.delivered => h.isPayer
          ? '$who says it is done — check it by ${day(h.autoReleaseAt)}'
          : 'Delivered — yours on ${day(h.autoReleaseAt)} unless they object',
      HeldStage.underReview => h.isPayer
          ? 'Being reviewed'
          : 'Being reviewed — add your side',
      HeldStage.coolingOff => 'Sending to $who shortly — you can still cancel',
      HeldStage.waitingToClaim => 'Waiting for $who to join',
      _ => '',
    };
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded || _items.isEmpty) return const SizedBox.shrink();
    return Column(
      children: [
        for (final h in _items)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () => _open(h),
              child: Glass(
                child: Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: (h.needsMe
                              ? EvabobColors.danger
                              : EvabobColors.blue)
                          .withValues(alpha: 0.12),
                      child: Icon(
                        h.isCoolingOff
                            ? Icons.timer_outlined
                            : Icons.lock_clock_rounded,
                        color: h.needsMe ? EvabobColors.danger : EvabobColors.blue,
                        size: 20,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            h.isPayer
                                ? '${formatMoney(h.amountUsdc)} to ${h.counterparty}'
                                : '${formatMoney(h.amountUsdc)} from ${h.counterparty}',
                            style: const TextStyle(
                              fontWeight: FontWeight.w400,
                              color: EvabobColors.navy,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            _line(h),
                            style: const TextStyle(
                              fontSize: 10,
                              color: EvabobColors.navyMuted,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const Icon(
                      Icons.chevron_right_rounded,
                      color: EvabobColors.inkTertiary,
                    ),
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }
}
