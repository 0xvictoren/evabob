import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/fx/fx_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/widgets/glass.dart';

/// A payment request in a chat: every line, the total, and what the person
/// looking at it can do.
///
/// The server builds the card from the request itself (never from what the
/// sender typed) and refreshes its status whenever the chat loads, so both
/// people see the same thing: unpaid, paid, declined, cancelled.
///
/// The person asked sees **Pay** and **Cancel** (which declines it: the card
/// closes for both and the sender is told). The person asking sees **Cancel
/// request** while it is open. A part-paid request shows what is left, and
/// the person asked sees **Pay the rest**.
class RequestCard extends StatelessWidget {
  const RequestCard({
    super.key,
    required this.meta,
    required this.mine,
    required this.createdAt,
    this.busy = false,
    this.onPay,
    this.onDecline,
    this.onCancel,
  });

  final Map<String, dynamic> meta;

  /// True when the person looking at it raised the request.
  final bool mine;
  final DateTime createdAt;
  final bool busy;
  final VoidCallback? onPay;
  final VoidCallback? onDecline;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final token = meta['token']?.toString() == 'EURC' ? 'EURC' : 'USDC';
    final total = (meta['total'] as num?)?.toDouble() ??
        (meta['amount'] as num?)?.toDouble() ??
        0;
    final items = ((meta['items'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final open = meta['open'] == true;
    // "Pay half, hold half" paid its first half but the rest was never held:
    // the person asked can pay what is left, and only that.
    final partial = meta['rawStatus']?.toString() == 'partial';
    final remaining = (meta['remaining'] as num?)?.toDouble() ?? 0;
    final status = meta['status']?.toString() ?? 'Request';
    final note = meta['note']?.toString() ?? '';
    final due = DateTime.tryParse(meta['dueAt']?.toString() ?? '');
    final df = DateFormat('d MMM, HH:mm');
    // In the reader's own currency: a ₦2,500 request reads ₦2,500 to someone
    // who uses naira, and its dollar amount to someone who uses dollars.
    final fx = context.watch<FxService>();
    final display = meta['display'] is Map
        ? Map<String, dynamic>.from(meta['display'] as Map)
        : const <String, dynamic>{};
    final headline = fx.requestPrimary(
      usd: total,
      token: token,
      displayCurrency: display['currency']?.toString(),
      displayAmount: (display['amount'] as num?)?.toDouble(),
    );
    final underneath = fx.secondaryToken(total, token);
    final displayAmount = (display['amount'] as num?)?.toDouble();
    final restLabel = fx.requestPrimary(
      usd: remaining,
      token: token,
      displayCurrency: display['currency']?.toString(),
      displayAmount: displayAmount == null || total <= 0
          ? null
          : displayAmount * remaining / total,
    );

    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Glass(
        heavy: true,
        borderRadius: 20,
        padding: const EdgeInsets.all(16),
        child: SizedBox(
          width: 270,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: (open ? EvabobColors.emerald : EvabobColors.sand)
                      .withValues(alpha: 0.2),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  status,
                  style: TextStyle(
                    fontSize: 10,
                    color: EvabobColors.emeraldDeep,
                  ),
                ),
              ),
              const SizedBox(height: 10),
              Text(
                mine ? 'You asked for' : 'Asking you for',
                style: Type.caption.copyWith(color: EvabobColors.navyMuted),
              ),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(
                  headline,
                  style: const TextStyle(
                    fontSize: 40,
                    color: EvabobColors.navy,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ),
              if (underneath.isNotEmpty)
                Text(
                  '≈ $underneath',
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
              const SizedBox(height: 8),
              for (final it in items)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: SelectableText(
                          it['description']?.toString() ?? 'Item',
                          style: const TextStyle(
                            fontSize: 13,
                            color: EvabobColors.navy,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        formatMoney(
                            (it['amount'] as num?)?.toDouble() ?? 0, token),
                        style: const TextStyle(
                          fontSize: 13,
                          color: EvabobColors.navy,
                        ),
                      ),
                    ],
                  ),
                ),
              if (items.length > 1) ...[
                const Divider(height: 12),
                Row(
                  children: [
                    const Expanded(
                      child: Text(
                        'Total',
                        style:
                            TextStyle(fontSize: 13, color: EvabobColors.navy),
                      ),
                    ),
                    Text(
                      headline,
                      style: const TextStyle(
                          fontSize: 13, color: EvabobColors.navy),
                    ),
                  ],
                ),
              ],
              if (note.isNotEmpty) ...[
                const SizedBox(height: 6),
                SelectableText(
                  note,
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
              ],
              const SizedBox(height: 8),
              Text(
                [
                  df.format(createdAt.toLocal()),
                  if (due != null && open)
                    'due ${DateFormat('d MMM').format(due.toLocal())}',
                ].join(' · '),
                style: const TextStyle(fontSize: 10, color: EvabobColors.chalk),
              ),
              if (open && !mine) ...[
                const SizedBox(height: 12),
                // Equal halves with tight padding: at a third of the card,
                // the theme's padding left "Cancel" too little room and it
                // broke into "Canc / el".
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: busy ? null : onDecline,
                        style: OutlinedButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          minimumSize: const Size(0, 48),
                        ),
                        child: const Text(
                          'Cancel',
                          maxLines: 1,
                          softWrap: false,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: FilledButton(
                        onPressed: busy ? null : onPay,
                        style: FilledButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          minimumSize: const Size(0, 48),
                        ),
                        child: busy
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2),
                              )
                            : const Text('Pay'),
                      ),
                    ),
                  ],
                ),
              ],
              if (partial && remaining > 0) ...[
                const SizedBox(height: 8),
                Text(
                  mine ? '$restLabel still to come' : '$restLabel left to pay',
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
              ],
              if (partial && remaining > 0 && !mine) ...[
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: busy ? null : onPay,
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      minimumSize: const Size(0, 48),
                    ),
                    child: busy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(
                            'Pay the rest · $restLabel',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                  ),
                ),
              ],
              if (open && mine && onCancel != null) ...[
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: TextButton(
                    onPressed: busy ? null : onCancel,
                    child: const Text('Cancel request'),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
