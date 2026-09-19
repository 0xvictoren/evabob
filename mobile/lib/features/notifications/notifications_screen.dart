import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/notifications/money_alerts.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import '../activity/receipt_sheet.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  bool _asking = false;
  bool _asked = false;

  Future<void> _askPermission() async {
    if (_asking) return;
    setState(() => _asking = true);
    await context.read<MoneyAlerts>().requestPermission();
    if (!mounted) return;
    setState(() {
      _asking = false;
      _asked = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final activity = context.watch<ActivityService>();
    final items = activity.items.take(12).toList(growable: false);
    final df = DateFormat('MMM d · HH:mm');

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: EvabobPageHeader(
                title: 'Notifications',
                onBack: widget.onBack,
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                color: EvabobColors.blue,
                onRefresh: activity.refresh,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
                  children: [
                    Glass(
                      child: Column(
                        children: [
                          Container(
                            width: 64,
                            height: 64,
                            decoration: const BoxDecoration(
                              color: EvabobColors.blueSoft,
                              shape: BoxShape.circle,
                            ),
                            child: const Icon(
                              Icons.notifications_none_rounded,
                              color: EvabobColors.ink,
                              size: 28,
                            ),
                          ),
                          const SizedBox(height: 16),
                          Text(
                            _asked
                                ? 'Notifications are ready'
                                : 'Know when money moves',
                            textAlign: TextAlign.center,
                            style: Type.title.copyWith(fontSize: 20),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            _asked
                                ? 'You can change this any time in your phone settings.'
                                : 'Get a quiet alert when money arrives, a request needs you, or a held payment changes.',
                            textAlign: TextAlign.center,
                            style: Type.body.copyWith(
                              color: EvabobColors.inkMuted,
                            ),
                          ),
                          const SizedBox(height: 20),
                          SizedBox(
                            width: double.infinity,
                            height: 52,
                            child: FilledButton(
                              onPressed:
                                  _asked || _asking ? null : _askPermission,
                              style: FilledButton.styleFrom(
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(12),
                                ),
                              ),
                              child: Text(
                                _asking
                                    ? 'Opening settings…'
                                    : _asked
                                        ? 'Allowed'
                                        : 'Allow notifications',
                              ),
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'No marketing messages.',
                            style: Type.caption.copyWith(
                              color: EvabobColors.inkTertiary,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 28),
                    const EvabobSectionLabel('Recent'),
                    const SizedBox(height: 10),
                    if (activity.loading && items.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(40),
                        child: Center(
                          child: CircularProgressIndicator(
                            color: EvabobColors.blue,
                          ),
                        ),
                      )
                    else if (items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 48),
                        child: Column(
                          children: [
                            const Icon(
                              Icons.notifications_off_outlined,
                              size: 40,
                              color: EvabobColors.inkTertiary,
                            ),
                            const SizedBox(height: 12),
                            Text(
                              'Nothing new',
                              style: Type.body,
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'Payment updates will appear here.',
                              style: Type.label.copyWith(
                                color: EvabobColors.inkMuted,
                              ),
                            ),
                          ],
                        ),
                      )
                    else
                      Glass(
                        padding: EdgeInsets.zero,
                        child: Column(
                          children: [
                            for (var i = 0; i < items.length; i++) ...[
                              _NotificationRow(
                                entry: items[i],
                                time: df.format(items[i].createdAt.toLocal()),
                                onTap: () =>
                                    ReceiptSheet.open(context, items[i]),
                              ),
                              if (i < items.length - 1)
                                const Padding(
                                  padding: EdgeInsets.only(left: 68),
                                  child: Divider(height: 1),
                                ),
                            ],
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _NotificationRow extends StatelessWidget {
  const _NotificationRow({
    required this.entry,
    required this.time,
    required this.onTap,
  });

  final ActivityEntry entry;
  final String time;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      minVerticalPadding: 12,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      leading: CircleAvatar(
        backgroundColor: entry.positive
            ? EvabobColors.moneyIn.withValues(alpha: .12)
            : EvabobColors.pageBg,
        child: Icon(
          entry.positive ? Icons.south_west_rounded : Icons.north_east_rounded,
          color: entry.positive ? EvabobColors.moneyIn : EvabobColors.blue,
          size: 18,
        ),
      ),
      title: Text(
        entry.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Type.body,
      ),
      subtitle: Text(
        time,
        style: Type.caption.copyWith(color: EvabobColors.inkTertiary),
      ),
      trailing: Text(
        entry.amountLine,
        style: Type.body.copyWith(
          color: entry.positive ? EvabobColors.moneyIn : EvabobColors.ink,
        ),
      ),
    );
  }
}
