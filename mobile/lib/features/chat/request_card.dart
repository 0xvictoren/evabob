import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

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
/// request** while it is open.
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
    final status = meta['status']?.toString() ?? 'Request';
    final note = meta['note']?.toString() ?? '';
    final due = DateTime.tryParse(meta['dueAt']?.toString() ?? '');
    final df = DateFormat('d MMM, HH:mm');

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
                  style: const TextStyle(
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
              Text(
                formatMoney(total, token),
                style: const TextStyle(
                  fontSize: 40,
                  color: EvabobColors.navy,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
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
                        style: TextStyle(fontSize: 13, color: EvabobColors.navy),
                      ),
                    ),
                    Text(
                      formatMoney(total, token),
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
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: busy ? null : onDecline,
                        child: const Text('Cancel'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      flex: 2,
                      child: FilledButton(
                        onPressed: busy ? null : onPay,
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
