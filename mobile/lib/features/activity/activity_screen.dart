import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/utils/money_format.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/wallet/circle_wallet_service.dart';
import 'incomplete_jobs_banner.dart';
import 'held_payments_banner.dart';
import 'receipt_sheet.dart';
import 'activity_thumb.dart';
import 'package:flutter_svg/flutter_svg.dart';
import '../../core/theme/evabob_tokens.dart';

class ActivityScreen extends StatefulWidget {
  const ActivityScreen({
    super.key,
    this.onBack,
    this.onSend,
    this.onTopUp,
  });

  final VoidCallback? onBack;
  final VoidCallback? onSend;
  final VoidCallback? onTopUp;

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

/// What the filter sheet narrows the list to. Figma "Activity · Filter".
class ActivityFilter {
  const ActivityFilter({
    this.show = 'all',
    this.when = 'any',
    this.person,
    this.ended,
  });

  /// all | in | out | held (the last only from the chips on the screen).
  final String show;

  /// any | today | 7 | 30
  final String when;

  /// A person's name as the rows show it, or null for anyone.
  final String? person;

  /// landed | on_the_way | failed | held, or null for any.
  final String? ended;

  bool get isDefault =>
      show == 'all' && when == 'any' && person == null && ended == null;

  ActivityFilter copyWith({
    String? show,
    String? when,
    String? Function()? person,
    String? Function()? ended,
  }) =>
      ActivityFilter(
        show: show ?? this.show,
        when: when ?? this.when,
        person: person != null ? person() : this.person,
        ended: ended != null ? ended() : this.ended,
      );

  static String personOf(ActivityEntry e) =>
      e.personName ?? e.counterparty ?? e.title;

  static String endedOf(ActivityEntry e) {
    if (e.didNotLand) return 'failed';
    if (e.isPending) return e.resumable ? 'held' : 'on_the_way';
    return 'landed';
  }

  List<ActivityEntry> apply(List<ActivityEntry> items) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return items.where((e) {
      if (show == 'in' && !e.positive) return false;
      if (show == 'out' && e.positive) return false;
      if (show == 'held' && !e.isPending) return false;
      final t = e.createdAt.toLocal();
      if (when == 'today' && t.isBefore(today)) return false;
      if (when == '7' && t.isBefore(today.subtract(const Duration(days: 6)))) {
        return false;
      }
      if (when == '30' &&
          t.isBefore(today.subtract(const Duration(days: 29)))) {
        return false;
      }
      if (person != null && personOf(e) != person) return false;
      if (ended != null && endedOf(e) != ended) return false;
      return true;
    }).toList();
  }
}

class _ActivityScreenState extends State<ActivityScreen> {
  ActivityFilter _f = const ActivityFilter();

  static const _chips = <(String, String, double)>[
    ('all', 'All', 60),
    ('in', 'Money in', 88),
    ('out', 'Money out', 96),
    ('held', 'On hold', 82),
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

  ({double sent, double received}) _totals(List<ActivityEntry> items) {
    var sent = 0.0;
    var received = 0.0;
    for (final e in items) {
      if (e.isPending || e.didNotLand) continue;
      if (e.kind == 'send' ||
          e.kind == 'bridge' ||
          e.kind == 'agent' ||
          (e.kind == 'exchange' && e.amountUsdc < 0)) {
        sent += e.displayAmount;
      }
      if (e.kind == 'receive' || (e.kind == 'exchange' && e.amountUsdc > 0)) {
        received += e.displayAmount;
      }
    }
    return (sent: sent, received: received);
  }

  Future<void> _openFilter(List<ActivityEntry> all) async {
    final picked = await ActivityFilterSheet.open(context, _f, all);
    if (picked != null && mounted) setState(() => _f = picked);
  }

  static String _subtitle(ActivityEntry e) {
    if (e.resumable) return 'On hold · tap to continue';
    if (e.didNotLand) return "Didn't land";
    if (e.isPending) {
      final who = ActivityFilter.personOf(e).split(' ').first.replaceFirst('@', '');
      return e.kind == 'send' || e.kind == 'escrow'
          ? 'Waiting for $who to join'
          : 'On the way';
    }
    if (e.kind == 'send') return 'You sent';
    if (e.kind == 'receive') return 'Sent to you';
    return kindLabel(e.kind);
  }

  Widget _row(BuildContext context, ActivityEntry e) {
    final color = e.isPending || e.didNotLand
        ? EvabobColors.slate
        : e.positive
            ? EvabobColors.moneyIn
            : EvabobColors.ink;
    return InkWell(
      onTap: e.resumable
          ? () => IncompleteJobsBanner.continueJob(context, e.jobId!)
          : () => ReceiptSheet.open(context, e),
      child: SizedBox(
        height: 72,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              ActivityThumb(entry: e),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      e.personName ?? e.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Type.body,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _subtitle(e),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Type.label.copyWith(
                        color: e.resumable
                            ? EvabobColors.danger
                            : EvabobColors.inkTertiary,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 130),
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerRight,
                      child: Text(
                        e.resumable ? 'Continue' : formatMoney(e.displayAmount, e.displayToken),
                        maxLines: 1,
                        style: Type.body.copyWith(
                          color: e.resumable ? EvabobColors.blue : color,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    DateFormat('HH:mm').format(e.createdAt.toLocal()),
                    style: Type.label.copyWith(color: EvabobColors.inkTertiary),
                  ),
                ],
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
    final items = _f.apply(activity.items);
    final monthStart = DateTime(DateTime.now().year, DateTime.now().month);
    final totals = _totals(activity.items
        .where((e) => !e.createdAt.toLocal().isBefore(monthStart))
        .toList());
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

    const card = BoxDecoration(
      color: EvabobColors.white,
      borderRadius: BorderRadius.all(Radius.circular(12)),
      boxShadow: Shadows.card,
    );
    const sectionStyle = TextStyle(
      fontSize: 10,
      height: 14 / 10,
      letterSpacing: .8,
      color: EvabobColors.inkTertiary,
    );

    // Figma "Activity" (5:255).
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
              child: Row(
                children: [
                  if (widget.onBack != null) ...[
                    IconButton(
                      onPressed: widget.onBack,
                      tooltip: 'Back',
                      icon: const Icon(Icons.chevron_left_rounded),
                    ),
                  ],
                  Text(
                    'Activity',
                    style: Type.title.copyWith(
                      fontSize: 24,
                      height: 32 / 24,
                      letterSpacing: -0.4,
                    ),
                  ),
                  const Spacer(),
                  Semantics(
                    button: true,
                    label: 'Filter activity',
                    child: GestureDetector(
                      onTap: () => _openFilter(activity.items),
                      child: SizedBox.square(
                        dimension: 44,
                        child: Stack(
                          alignment: Alignment.center,
                          children: [
                            SvgPicture.asset('assets/figma/btn_filter.svg',
                                width: 44, height: 44),
                            const Text(
                              '≡',
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontWeight: FontWeight.w900,
                                fontSize: 18,
                                height: 24 / 18,
                                color: EvabobColors.ink,
                              ),
                            ),
                            if (!_f.isDefault)
                              Positioned(
                                top: 8,
                                right: 8,
                                child: CircleAvatar(
                                  radius: 4,
                                  backgroundColor: EvabobColors.blue,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (activity.loading && activity.items.isEmpty)
              const Expanded(child: _ActivityLoadingState())
            else if (activity.error != null && activity.items.isEmpty)
              Expanded(
                child: _ActivityOfflineState(onRetry: activity.refresh),
              )
            else if (activity.items.isEmpty)
              Expanded(
                child: _ActivityEmptyState(
                  onSend: widget.onSend,
                  onTopUp: widget.onTopUp,
                ),
              )
            else
              Expanded(
                child: RefreshIndicator(
                  color: EvabobColors.blue,
                  onRefresh: activity.refresh,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(20, 14, 20, 120),
                    children: [
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            for (final c in _chips) ...[
                              _Pill(
                                label: c.$2,
                                width: c.$3,
                                height: 36,
                                selected: _f.show == c.$1,
                                idle: EvabobColors.white,
                                onTap: () => setState(
                                    () => _f = _f.copyWith(show: c.$1)),
                              ),
                              if (c != _chips.last) const SizedBox(width: 8),
                            ],
                          ],
                        ),
                      ),
                      const SizedBox(height: 20),
                      const Text('THIS MONTH', style: sectionStyle),
                      const SizedBox(height: 8),
                      Container(
                        height: 92,
                        decoration: card,
                        padding: const EdgeInsets.fromLTRB(28, 22, 20, 22),
                        child: Row(
                          children: [
                            Expanded(
                              child: _Total(
                                label: 'Money in',
                                value: formatMoney(totals.received),
                                color: EvabobColors.moneyIn,
                              ),
                            ),
                            Container(
                              width: 1,
                              height: 48,
                              color: EvabobColors.hairline,
                            ),
                            const SizedBox(width: 20),
                            Expanded(
                              child: _Total(
                                label: 'Money out',
                                value: formatMoney(totals.sent),
                                color: EvabobColors.ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      const IncompleteJobsBanner(),
                      const HeldPaymentsBanner(),
                      if (items.isEmpty)
                        Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            children: [
                              Text(
                                'Nothing here. Try clearing what you are filtering by.',
                                textAlign: TextAlign.center,
                                style: Type.body
                                    .copyWith(color: EvabobColors.slate),
                              ),
                              TextButton(
                                onPressed: () => setState(
                                    () => _f = const ActivityFilter()),
                                child: const Text('Show everything'),
                              ),
                            ],
                          ),
                        ),
                      for (final group in groups.entries) ...[
                        const SizedBox(height: 8),
                        Text(group.key, style: sectionStyle),
                        const SizedBox(height: 8),
                        Container(
                          decoration: card,
                          clipBehavior: Clip.antiAlias,
                          child: Column(
                            children: [
                              for (var i = 0; i < group.value.length; i++) ...[
                                _row(context, group.value[i]),
                                if (i < group.value.length - 1)
                                  const Padding(
                                    padding: EdgeInsets.only(left: 68, right: 20),
                                    child: Divider(
                                        height: 1,
                                        color: EvabobColors.hairline),
                                  ),
                              ],
                            ],
                          ),
                        ),
                        const SizedBox(height: 16),
                      ],
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

class _Total extends StatelessWidget {
  const _Total({required this.label, required this.value, required this.color});

  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Text(
          label,
          style: Type.label.copyWith(
            color: EvabobColors.inkTertiary,
            letterSpacing: 0.4,
          ),
        ),
        const SizedBox(height: 4),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(value, style: Type.title.copyWith(color: color)),
        ),
      ],
    );
  }
}

/// A rounded filter chip as the designs draw it: filled blue when chosen.
class _Pill extends StatelessWidget {
  const _Pill({
    required this.label,
    required this.selected,
    required this.onTap,
    required this.idle,
    this.width,
    this.height = 40,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final Color idle;
  final double? width;
  final double height;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      // A fixed width centres the label; without one the pill hugs it.
      child: Container(
        width: width,
        height: width == null ? null : height,
        padding: width == null
            ? EdgeInsets.symmetric(horizontal: 20, vertical: (height - 18) / 2)
            : null,
        alignment: width == null ? null : Alignment.center,
        decoration: BoxDecoration(
          color: selected ? EvabobColors.blue : idle,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(
          label,
          maxLines: 1,
          softWrap: false,
          style: Type.body.copyWith(
            color: selected
                ? (idle == EvabobColors.white
                    ? EvabobColors.pageBg
                    : EvabobColors.white)
                : EvabobColors.slate,
          ),
        ),
      ),
    );
  }
}

/// Figma "Activity · Filter" (18:970): what to show, when, with whom, and
/// how it ended — with the number of matches on the button.
class ActivityFilterSheet extends StatefulWidget {
  const ActivityFilterSheet({super.key, required this.initial, required this.items});

  final ActivityFilter initial;
  final List<ActivityEntry> items;

  static Future<ActivityFilter?> open(
    BuildContext context,
    ActivityFilter current,
    List<ActivityEntry> items,
  ) {
    return showModalBottomSheet<ActivityFilter>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      barrierColor: const Color(0xA60B1620),
      builder: (_) => ActivityFilterSheet(initial: current, items: items),
    );
  }

  @override
  State<ActivityFilterSheet> createState() => _ActivityFilterSheetState();
}

class _ActivityFilterSheetState extends State<ActivityFilterSheet> {
  late ActivityFilter _f = widget.initial;

  /// The people they deal with most, for the row of faces.
  List<ActivityEntry> get _people {
    final seen = <String, ActivityEntry>{};
    final counts = <String, int>{};
    for (final e in widget.items) {
      if (e.personName == null) continue;
      final k = ActivityFilter.personOf(e);
      seen.putIfAbsent(k, () => e);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    final keys = seen.keys.toList()
      ..sort((a, b) => (counts[b] ?? 0).compareTo(counts[a] ?? 0));
    return [for (final k in keys.take(4)) seen[k]!];
  }

  @override
  Widget build(BuildContext context) {
    const section = TextStyle(
      fontSize: 10,
      height: 14 / 10,
      letterSpacing: .8,
      color: EvabobColors.inkTertiary,
    );
    final count = _f.apply(widget.items).length;

    // Widths are the design's, so each row fits on one line.
    Widget chips(List<(String?, String, double)> options, String? value,
        void Function(String?) pick) {
      return Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final o in options)
            _Pill(
              label: o.$2,
              width: o.$3,
              selected: value == o.$1,
              idle: EvabobColors.pageBg,
              onTap: () => pick(o.$1),
            ),
        ],
      );
    }

    Widget face({
      required bool selected,
      required String label,
      required Widget child,
      required VoidCallback onTap,
    }) {
      return GestureDetector(
        onTap: onTap,
        child: SizedBox(
          width: 56,
          child: Column(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: selected
                      ? Border.all(color: EvabobColors.blue, width: 2)
                      : null,
                ),
                child: ClipOval(child: child),
              ),
              const SizedBox(height: 8),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Type.label.copyWith(
                  color: selected ? EvabobColors.blue : EvabobColors.slate,
                ),
              ),
            ],
          ),
        ),
      );
    }

    return Container(
      decoration: const BoxDecoration(
        color: EvabobColors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        boxShadow: [
          BoxShadow(color: Color(0x290B1620), blurRadius: 40, offset: Offset(0, -8)),
        ],
      ),
      padding: EdgeInsets.fromLTRB(
          20, 16, 20, 16 + MediaQuery.paddingOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: EvabobColors.hairline,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                Text(
                  'Filter',
                  style: Type.title.copyWith(
                      fontSize: 24, height: 32 / 24, letterSpacing: -0.4),
                ),
                const Spacer(),
                GestureDetector(
                  onTap: () => setState(() => _f = const ActivityFilter()),
                  child: Text('Reset',
                      style: Type.body.copyWith(color: EvabobColors.blue)),
                ),
              ],
            ),
            const SizedBox(height: 20),
            const Text('SHOW', style: section),
            const SizedBox(height: 10),
            chips(
              const [
                ('all', 'All', 74),
                ('in', 'Money in', 112),
                ('out', 'Money out', 111),
              ],
              _f.show == 'held' ? 'all' : _f.show,
              (v) => setState(() => _f = _f.copyWith(show: v)),
            ),
            const SizedBox(height: 28),
            const Text('WHEN', style: section),
            const SizedBox(height: 10),
            chips(
              const [
                ('any', 'Any time', 81),
                ('today', 'Today', 82),
                ('7', '7 days', 81),
                ('30', '30 days', 82),
              ],
              _f.when,
              (v) => setState(() => _f = _f.copyWith(when: v)),
            ),
            const SizedBox(height: 28),
            const Text('PEOPLE', style: section),
            const SizedBox(height: 10),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  face(
                    selected: _f.person == null,
                    label: 'Anyone',
                    onTap: () => setState(() => _f = _f.copyWith(person: () => null)),
                    child: Container(
                      color: EvabobColors.pageBg,
                      alignment: Alignment.center,
                      child: Text(
                        'All',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          fontWeight: FontWeight.w900,
                          fontSize: 14,
                          color: EvabobColors.blue,
                        ),
                      ),
                    ),
                  ),
                  for (final e in _people) ...[
                    const SizedBox(width: 16),
                    face(
                      selected: _f.person == ActivityFilter.personOf(e),
                      label: ActivityFilter.personOf(e).split(' ').first,
                      onTap: () => setState(() => _f = _f.copyWith(
                          person: () => ActivityFilter.personOf(e))),
                      child: ActivityThumb(entry: e, size: 48),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 24),
            const Text('HOW IT ENDED', style: section),
            const SizedBox(height: 10),
            chips(
              const [
                ('landed', 'Landed', 66),
                ('on_the_way', 'On the way', 96),
                ('failed', "Didn't land", 90),
                ('held', 'On hold', 73),
              ],
              _f.ended,
              // Tapping the chosen one again clears it.
              (v) => setState(() =>
                  _f = _f.copyWith(ended: () => _f.ended == v ? null : v)),
            ),
            const SizedBox(height: 32),
            DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.all(Radius.circular(999)),
                boxShadow: [
                  BoxShadow(
                    color: EvabobColors.buttonGlow,
                    blurRadius: 24,
                    spreadRadius: -6,
                    offset: Offset(0, 10),
                  ),
                ],
              ),
              child: SizedBox(
                width: double.infinity,
                height: 56,
                child: FilledButton(
                  onPressed: () => Navigator.pop(context, _f),
                  style: FilledButton.styleFrom(
                    backgroundColor: EvabobColors.blue,
                    shape: const StadiumBorder(),
                  ),
                  child: Text(
                    'Show $count ${count == 1 ? 'result' : 'results'}',
                    style: Type.body.copyWith(color: EvabobColors.white),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActivityEmptyState extends StatelessWidget {
  const _ActivityEmptyState({this.onSend, this.onTopUp});

  final VoidCallback? onSend;
  final VoidCallback? onTopUp;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 140, 20, 28),
      child: Column(
        children: [
          Container(
            width: 88,
            height: 88,
            decoration: BoxDecoration(
              color: EvabobColors.blueSoft,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.receipt_long_rounded,
              color: EvabobColors.ink,
              size: 40,
            ),
          ),
          const SizedBox(height: 44),
          const Text(
            'Nothing here yet',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: 'Numans',
              fontSize: 24,
              height: 32 / 24,
              letterSpacing: -.4,
              color: EvabobColors.ink,
            ),
          ),
          const SizedBox(height: 4),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              'Every payment and receipt shows up here, the moment money moves.',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 14,
                height: 18 / 14,
                letterSpacing: -.1,
                color: EvabobColors.ink,
              ),
            ),
          ),
          const SizedBox(height: 48),
          SizedBox(
            width: double.infinity,
            height: 56,
            child: FilledButton(
              onPressed: onSend,
              style: FilledButton.styleFrom(
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: const Text('Send your first payment'),
            ),
          ),
          const SizedBox(height: 6),
          TextButton(
            onPressed: onTopUp,
            child: const Text(
              'Top up your balance',
              style: TextStyle(color: EvabobColors.ink),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActivityOfflineState extends StatelessWidget {
  const _ActivityOfflineState({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 132, 20, 28),
      child: Column(
        children: [
          Container(
            width: 88,
            height: 88,
            decoration: const BoxDecoration(
              color: EvabobColors.white,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: const Text(
              '!',
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 28,
                height: 32 / 28,
                color: EvabobColors.ink,
              ),
            ),
          ),
          const SizedBox(height: 44),
          const Text(
            "You're offline",
            style: TextStyle(
              fontFamily: 'Numans',
              fontSize: 24,
              height: 32 / 24,
              letterSpacing: -.4,
            ),
          ),
          const SizedBox(height: 2),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              "We can't reach Evabob right now. What you see is the last thing we knew.",
              textAlign: TextAlign.center,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 14,
                height: 18 / 14,
                letterSpacing: -.1,
              ),
            ),
          ),
          const SizedBox(height: 48),
          Container(
            height: 56,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
              color: EvabobColors.white,
              borderRadius: BorderRadius.circular(12),
              boxShadow: const [
                BoxShadow(
                  color: Color(0x0F0B1620),
                  blurRadius: 24,
                  spreadRadius: -6,
                ),
              ],
            ),
            child: const Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('Last updated'),
                Text('A moment ago'),
              ],
            ),
          ),
          const SizedBox(height: 44),
          SizedBox(
            width: double.infinity,
            height: 56,
            child: FilledButton(
              onPressed: onRetry,
              style: FilledButton.styleFrom(
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              child: const Text('Try again'),
            ),
          ),
          const SizedBox(height: 24),
          const Text(
            "Nothing you started is lost. We'll finish it when you're back.",
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: 'Inter',
              fontSize: 10,
              height: 14 / 10,
              letterSpacing: .2,
              color: EvabobColors.inkMuted,
            ),
          ),
        ],
      ),
    );
  }
}

class _ActivityLoadingState extends StatefulWidget {
  const _ActivityLoadingState();

  @override
  State<_ActivityLoadingState> createState() => _ActivityLoadingStateState();
}

class _ActivityLoadingStateState extends State<_ActivityLoadingState>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final color = Color.lerp(
          const Color(0xFFDCE8EE),
          const Color(0xFFF7FBFD),
          _controller.value,
        )!;
        Widget block(double width, double height, {double radius = 8}) {
          return Container(
            width: width,
            height: height,
            decoration: BoxDecoration(
              color: color,
              borderRadius: BorderRadius.circular(radius),
            ),
          );
        }

        return ListView(
          physics: const NeverScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(20, 28, 20, 100),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: block(72, 12, radius: 6),
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerLeft,
              child: block(196, 42, radius: 10),
            ),
            const SizedBox(height: 32),
            Row(
              children: [
                for (var i = 0; i < 4; i++) ...[
                  Expanded(child: block(double.infinity, 38, radius: 12)),
                  if (i < 3) const SizedBox(width: 8),
                ],
              ],
            ),
            const SizedBox(height: 32),
            Align(
              alignment: Alignment.centerLeft,
              child: block(92, 12, radius: 6),
            ),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: EvabobColors.white,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                children: [
                  for (var i = 0; i < 3; i++) ...[
                    Row(
                      children: [
                        block(40, 40, radius: 999),
                        const SizedBox(width: 12),
                        Expanded(child: block(double.infinity, 14)),
                        const SizedBox(width: 20),
                        block(64, 14),
                      ],
                    ),
                    if (i < 2) const SizedBox(height: 18),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 28),
            const Text(
              'Updating your activity…',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 10,
                height: 1.4,
                letterSpacing: .2,
                color: EvabobColors.inkTertiary,
              ),
            ),
          ],
        );
      },
    );
  }
}
