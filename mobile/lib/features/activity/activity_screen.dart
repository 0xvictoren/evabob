import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/utils/money_format.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'incomplete_jobs_banner.dart';
import 'held_payments_banner.dart';
import 'receipt_sheet.dart';

class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key, this.onBack});

  final VoidCallback? onBack;

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  String _filter = 'all';
  DateTimeRange? _range;

  static const _filters = <(String, String)>[
    ('all', 'All'),
    ('in', 'Money in'),
    ('out', 'Money out'),
    ('held', 'On hold'),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<ActivityService>().refresh();
      try {
        context.read<CircleWalletService>().refreshOpenJobs();
      } catch (_) {}
    });
  }

  IconData _icon(String kind) {
    switch (kind) {
      case 'send':
        return Icons.north_east_rounded;
      case 'receive':
        return Icons.south_west_rounded;
      case 'exchange':
        return Icons.swap_horiz_rounded;
      case 'bridge':
        return Icons.hub_outlined;
      case 'agent':
        return Icons.smart_toy_outlined;
      default:
        return Icons.receipt_long_rounded;
    }
  }

  List<ActivityEntry> _filtered(List<ActivityEntry> items) {
    var list = items;
    if (_filter == 'in') list = list.where((e) => e.positive).toList();
    if (_filter == 'out') list = list.where((e) => !e.positive).toList();
    if (_filter == 'held') list = list.where((e) => e.isPending).toList();
    if (_range != null) {
      final start = DateTime(
        _range!.start.year,
        _range!.start.month,
        _range!.start.day,
      );
      final end = DateTime(
        _range!.end.year,
        _range!.end.month,
        _range!.end.day,
        23,
        59,
        59,
      );
      list = list.where((e) {
        final t = e.createdAt.toLocal();
        return !t.isBefore(start) && !t.isAfter(end);
      }).toList();
    }
    return list;
  }

  ({double sent, double received, int sendCount, int receiveCount}) _totals(
    List<ActivityEntry> items,
  ) {
    var sent = 0.0;
    var received = 0.0;
    var sendCount = 0;
    var receiveCount = 0;
    for (final e in items) {
      if (e.isPending) continue;
      if (e.kind == 'send' ||
          e.kind == 'bridge' ||
          e.kind == 'agent' ||
          (e.kind == 'exchange' && e.amountUsdc < 0)) {
        sent += e.displayAmount;
        sendCount++;
      }
      if (e.kind == 'receive' || (e.kind == 'exchange' && e.amountUsdc > 0)) {
        received += e.displayAmount;
        receiveCount++;
      }
    }
    return (
      sent: sent,
      received: received,
      sendCount: sendCount,
      receiveCount: receiveCount,
    );
  }

  Future<void> _pickRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 2),
      lastDate: now,
      initialDateRange: _range ??
          DateTimeRange(
            start: now.subtract(const Duration(days: 30)),
            end: now,
          ),
    );
    if (picked != null) setState(() => _range = picked);
  }

  Widget _activityRow(
    BuildContext context,
    ActivityEntry entry,
    DateFormat timeFormat,
  ) {
    final positive = entry.amountUsdc > 0;
    return PressScale(
      onTap: entry.resumable
          ? () => IncompleteJobsBanner.continueJob(context, entry.jobId!)
          : () => ReceiptSheet.open(context, entry),
      child: SizedBox(
        height: 72,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              CircleAvatar(
                radius: 20,
                backgroundColor: (entry.isPending
                        ? EvabobColors.danger
                        : EvabobColors.pageBg)
                    .withValues(alpha: entry.isPending ? .12 : 1),
                child: Icon(
                  entry.isPending
                      ? Icons.pending_actions_rounded
                      : _icon(entry.kind),
                  color:
                      entry.isPending ? EvabobColors.danger : EvabobColors.blue,
                  size: 18,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      entry.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 14,
                        color: EvabobColors.ink,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      entry.isPending
                          ? 'On hold · tap to continue'
                          : '${kindLabel(entry.kind)} · ${timeFormat.format(entry.createdAt.toLocal())}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10,
                        color: entry.isPending
                            ? EvabobColors.danger
                            : EvabobColors.inkTertiary,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                entry.resumable
                    ? 'Continue'
                    : entry.isPending
                        ? 'On hold'
                        : entry.amountLine,
                style: TextStyle(
                  fontSize: 14,
                  color: entry.resumable
                      ? EvabobColors.blue
                      : entry.isPending
                          ? EvabobColors.inkMuted
                          : positive
                              ? EvabobColors.moneyIn
                              : EvabobColors.ink,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final activity = context.watch<ActivityService>();
    final df = DateFormat('MMM d · HH:mm');
    final items = _filtered(activity.items);
    final totals = _totals(items);
    final now = DateTime.now();
    final groups = <String, List<ActivityEntry>>{};
    for (final entry in items) {
      final local = entry.createdAt.toLocal();
      final yesterday = now.subtract(const Duration(days: 1));
      final label = DateUtils.isSameDay(local, now)
          ? 'TODAY'
          : DateUtils.isSameDay(local, yesterday)
              ? 'YESTERDAY'
              : DateFormat('MMM d').format(local).toUpperCase();
      groups.putIfAbsent(label, () => []).add(entry);
    }

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: EvabobPageHeader(
                title: 'Activity',
                root: widget.onBack == null,
                onBack: widget.onBack,
                trailing: Semantics(
                  button: true,
                  label: 'Filter activity',
                  child: PressScale(
                    onTap: _pickRange,
                    child: const SizedBox.square(
                      dimension: 44,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: EvabobColors.blue,
                          shape: BoxShape.circle,
                        ),
                        child: Icon(
                          Icons.tune_rounded,
                          size: 18,
                          color: EvabobColors.white,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            if (_range != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${DateFormat.yMMMd().format(_range!.start)} – ${DateFormat.yMMMd().format(_range!.end)}',
                        style: const TextStyle(
                          fontSize: 10,
                          color: EvabobColors.emeraldDeep,
                          fontWeight: FontWeight.w400,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: () => setState(() => _range = null),
                      child: const Text('Clear'),
                    ),
                  ],
                ),
              ),
            SizedBox(
              height: 52,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 20),
                children: [
                  for (final f in _filters)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(f.$2),
                        selected: _filter == f.$1,
                        onSelected: (_) => setState(() => _filter = f.$1),
                      ),
                    ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 12, 20, 8),
              child: Text(
                'THIS MONTH',
                style: TextStyle(
                  color: EvabobColors.inkTertiary,
                  fontSize: 10,
                  height: 1.4,
                  letterSpacing: .8,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: SizedBox(
                height: 92,
                child: Glass(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 28,
                    vertical: 20,
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Text(
                              'Money in',
                              style: TextStyle(
                                fontSize: 10,
                                color: EvabobColors.inkTertiary,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              formatMoney(totals.received),
                              style: const TextStyle(
                                fontSize: 22,
                                color: EvabobColors.moneyIn,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const VerticalDivider(
                        width: 40,
                        thickness: 1,
                        color: EvabobColors.hairline,
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Text(
                              'Money out',
                              style: TextStyle(
                                fontSize: 10,
                                color: EvabobColors.inkTertiary,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              formatMoney(totals.sent),
                              style: const TextStyle(
                                fontSize: 22,
                                color: EvabobColors.ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: IncompleteJobsBanner(),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: HeldPaymentsBanner(),
            ),
            Expanded(
              child: activity.loading && activity.items.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : items.isEmpty
                      // Three different situations shared one message, and it
                      // was written in the developer's words ("filter /
                      // range"). A failed load in particular read as "you have
                      // nothing", which is the worst of the three to get wrong.
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  activity.error != null
                                      ? 'Could not load your activity.'
                                      : (_filter != 'all' || _range != null)
                                          ? 'Nothing here. Try clearing what '
                                              'you are filtering by.'
                                          : 'Nothing yet. Once money comes in '
                                              'or goes out, it shows up here.',
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(
                                    color: EvabobColors.navyMuted,
                                  ),
                                ),
                                if (activity.error != null) ...[
                                  const SizedBox(height: 8),
                                  TextButton(
                                    onPressed: () => activity.refresh(),
                                    style: TextButton.styleFrom(
                                      minimumSize: const Size(0, 44),
                                    ),
                                    child: const Text('Try again'),
                                  ),
                                ] else if (_filter != 'all' ||
                                    _range != null) ...[
                                  const SizedBox(height: 8),
                                  TextButton(
                                    onPressed: () => setState(() {
                                      _filter = 'all';
                                      _range = null;
                                    }),
                                    style: TextButton.styleFrom(
                                      minimumSize: const Size(0, 44),
                                    ),
                                    child: const Text('Show everything'),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        )
                      : ListView(
                          padding: const EdgeInsets.fromLTRB(20, 8, 20, 100),
                          children: [
                            for (final group in groups.entries) ...[
                              Padding(
                                padding:
                                    const EdgeInsets.only(bottom: 8, top: 8),
                                child: Text(
                                  group.key,
                                  style: const TextStyle(
                                    fontSize: 10,
                                    height: 1.4,
                                    letterSpacing: .8,
                                    color: EvabobColors.inkTertiary,
                                  ),
                                ),
                              ),
                              Glass(
                                padding: EdgeInsets.zero,
                                child: Column(
                                  children: [
                                    for (var i = 0;
                                        i < group.value.length;
                                        i++) ...[
                                      _activityRow(context, group.value[i], df),
                                      if (i < group.value.length - 1)
                                        const Padding(
                                          padding: EdgeInsets.only(left: 72),
                                          child: Divider(height: 1),
                                        ),
                                    ],
                                  ],
                                ),
                              ),
                            ],
                          ],
                        ),
            ),
          ],
        ),
      ),
    );
  }
}
