import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/navigation/app_link_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/widgets/glass.dart';

/// An Evabob link shown as what it is — sell with a link, a collection, a
/// task, an agent, a claim, a proof of payment — with the one thing to do.
///
/// Built by the server from Evabob's own records (services/evabobLinks.ts),
/// in chats and in the assistant alike.
class LinkCard extends StatelessWidget {
  const LinkCard({super.key, required this.meta, this.mine = false});

  final Map<String, dynamic> meta;
  final bool mine;

  static bool isLinkCard(Map<String, dynamic>? meta) =>
      meta?['type']?.toString() == 'link_card';

  IconData get _icon => switch ((meta['link'] as Map?)?['kind']?.toString()) {
        'hold' => Icons.shopping_bag_outlined,
        'group' => Icons.groups_2_outlined,
        'task' => Icons.handshake_outlined,
        'agent' => Icons.smart_toy_outlined,
        'claim' => Icons.redeem_outlined,
        'receipt' => Icons.receipt_long_outlined,
        'paywall' => Icons.sell_outlined,
        _ => Icons.link_rounded,
      };

  @override
  Widget build(BuildContext context) {
    final title = meta['title']?.toString() ?? 'Evabob link';
    final subtitle = meta['subtitle']?.toString() ?? '';
    final status = meta['status']?.toString() ?? '';
    final amount = (meta['amount'] as num?)?.toDouble();
    final token = meta['token']?.toString() ?? 'USDC';
    final action = meta['action'] is Map
        ? Map<String, dynamic>.from(meta['action'] as Map)
        : null;
    final deepLink = action?['deepLink']?.toString();
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 320),
        child: Glass(
          heavy: true,
          borderRadius: 20,
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(_icon, color: EvabobColors.blue),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      title,
                      style: Type.body.copyWith(color: EvabobColors.nearBlack),
                    ),
                  ),
                  if (amount != null) ...[
                    const SizedBox(width: 8),
                    Text(
                      formatMoney(amount, token),
                      style: Type.body.copyWith(color: EvabobColors.nearBlack),
                    ),
                  ],
                ],
              ),
              if (subtitle.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  subtitle,
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
              ],
              if (status.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  status,
                  style: Type.caption.copyWith(color: EvabobColors.emeraldDeep),
                ),
              ],
              if (action != null && deepLink != null && deepLink.isNotEmpty) ...[
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: () =>
                        context.read<AppLinkService>().open(Uri.parse(deepLink)),
                    child: Text(action['label']?.toString() ?? 'Open'),
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
