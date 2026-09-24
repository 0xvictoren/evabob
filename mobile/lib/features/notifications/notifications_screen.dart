import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/notifications/money_alerts.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../activity/receipt_sheet.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../core/utils/money_format.dart';
import '../activity/activity_thumb.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, required this.onBack});

  final VoidCallback onBack;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen>
    with WidgetsBindingObserver {
  bool _asking = false;

  /// What the phone says now. Null until checked, so the prompt does not
  /// flash for someone who already allowed notifications.
  bool? _allowed;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _check();
    _loadSeen();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Back from the phone's settings: they may have just turned it on or off.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _check();
  }

  Future<void> _check() async {
    final ok = await context.read<MoneyAlerts>().permissionGranted();
    if (mounted) setState(() => _allowed = ok);
  }

  Future<void> _askPermission() async {
    if (_asking) return;
    setState(() => _asking = true);
    final ok = await context.read<MoneyAlerts>().requestPermission();
    if (!mounted) return;
    setState(() {
      _asking = false;
      _allowed = ok;
    });
  }

  /// When they last looked. Anything newer is "New", with a dot.
  DateTime? _seenAt;
  static const _seenKey = 'evabob_notifications_seen_at_v1';

  Future<void> _loadSeen() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final ms = prefs.getInt(_seenKey);
      if (mounted) {
        setState(() => _seenAt = ms == null
            ? DateTime.fromMillisecondsSinceEpoch(0)
            : DateTime.fromMillisecondsSinceEpoch(ms));
      }
      // Seen from now on; the dots stay for this visit.
      await prefs.setInt(_seenKey, DateTime.now().millisecondsSinceEpoch);
    } catch (_) {}
  }

  static String _when(DateTime at) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final days =
        today.difference(DateTime(at.year, at.month, at.day)).inDays;
    if (days <= 0) return DateFormat('H:mm').format(at);
    if (days == 1) return 'Yesterday';
    return DateFormat('d MMM').format(at);
  }

  @override
  Widget build(BuildContext context) {
    final activity = context.watch<ActivityService>();
    final items = activity.items.take(20).toList(growable: false);
    final seen = _seenAt;
    final fresh = seen == null
        ? const <ActivityEntry>[]
        : items.where((e) => e.createdAt.isAfter(seen)).toList();
    final earlier = items.where((e) => !fresh.contains(e)).toList();
    const section = TextStyle(
      fontSize: 10,
      height: 14 / 10,
      letterSpacing: .8,
      color: EvabobColors.inkTertiary,
    );

    Widget card(List<ActivityEntry> list, {required bool unread}) {
      return Container(
        decoration: const BoxDecoration(
          color: EvabobColors.white,
          borderRadius: BorderRadius.all(Radius.circular(12)),
          boxShadow: Shadows.card,
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            for (var i = 0; i < list.length; i++) ...[
              _NotificationRow(
                entry: list[i],
                unread: unread,
                time: _when(list[i].createdAt.toLocal()),
                onTap: () => ReceiptSheet.open(context, list[i]),
              ),
              if (i < list.length - 1)
                const Padding(
                  padding: EdgeInsets.only(left: 76, right: 16),
                  child: Divider(height: 1, color: EvabobColors.hairline),
                ),
            ],
          ],
        ),
      );
    }

    // Figma "Notifications" (21:1284).
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          color: EvabobColors.blue,
          onRefresh: activity.refresh,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 32),
            children: [
              SizedBox(
                height: 44,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Semantics(
                        button: true,
                        label: 'Back',
                        child: GestureDetector(
                          onTap: widget.onBack,
                          child: SizedBox.square(
                            dimension: 44,
                            child: Stack(
                              alignment: Alignment.center,
                              children: [
                                SvgPicture.asset('assets/figma/btn_back.svg',
                                    width: 44, height: 44),
                                const Text(
                                  '‹',
                                  style: TextStyle(
                                    fontFamily: 'Inter',
                                    fontWeight: FontWeight.w900,
                                    fontSize: 22,
                                    height: 28 / 22,
                                    color: EvabobColors.ink,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    Text(
                      'Notifications',
                      style: Type.title.copyWith(
                        fontSize: 24,
                        height: 32 / 24,
                        letterSpacing: -0.4,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 22),
              // Only while notifications are actually off on the phone.
              if (_allowed == false) ...[
                _PermissionCard(
                  asking: _asking,
                  onAllow: _askPermission,
                ),
                const SizedBox(height: 24),
              ],
              if (activity.loading && items.isEmpty)
                Padding(
                  padding: EdgeInsets.all(40),
                  child: Center(
                    child: CircularProgressIndicator(color: EvabobColors.blue),
                  ),
                )
              else if (items.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 48),
                  child: Column(
                    children: [
                      Text('Nothing new', style: Type.body),
                      const SizedBox(height: 4),
                      Text(
                        'Payment updates will appear here.',
                        style: Type.label.copyWith(color: EvabobColors.slate),
                      ),
                    ],
                  ),
                )
              else ...[
                if (fresh.isNotEmpty) ...[
                  const Text('NEW', style: section),
                  const SizedBox(height: 10),
                  card(fresh, unread: true),
                  const SizedBox(height: 32),
                ],
                if (earlier.isNotEmpty) ...[
                  Text(fresh.isEmpty ? 'RECENT' : 'EARLIER', style: section),
                  const SizedBox(height: 10),
                  card(earlier, unread: false),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _PermissionCard extends StatelessWidget {
  const _PermissionCard({required this.asking, required this.onAllow});

  final bool asking;
  final VoidCallback onAllow;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: const BoxDecoration(
        color: EvabobColors.white,
        borderRadius: BorderRadius.all(Radius.circular(12)),
        boxShadow: Shadows.card,
      ),
      child: Column(
        children: [
          Text(
            'Know when money moves',
            textAlign: TextAlign.center,
            style: Type.title.copyWith(fontSize: 20),
          ),
          const SizedBox(height: 6),
          Text(
            'Get a quiet alert when money arrives, a request needs you, or a held payment changes.',
            textAlign: TextAlign.center,
            style: Type.body.copyWith(color: EvabobColors.slate),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: FilledButton(
              onPressed: asking ? null : onAllow,
              style: FilledButton.styleFrom(shape: const StadiumBorder()),
              child: Text(asking ? 'Opening settings…' : 'Allow notifications'),
            ),
          ),
        ],
      ),
    );
  }
}

/// One line of news, worded for a person rather than as a ledger row.
class _NotificationRow extends StatelessWidget {
  const _NotificationRow({
    required this.entry,
    required this.unread,
    required this.time,
    required this.onTap,
  });

  final ActivityEntry entry;
  final bool unread;
  final String time;
  final VoidCallback onTap;

  (String, String) _words() {
    final e = entry;
    final amount = formatMoney(e.displayAmount, e.displayToken);
    final name = e.personName;
    final first = name?.split(' ').first.replaceFirst('@', '');
    switch (e.kind) {
      case 'send':
        if (e.didNotLand) return ("Your $amount didn't land", 'Nothing left your balance');
        if (e.isPending) return ('Your $amount is on its way', name == null ? 'We will tell you when it lands' : 'To $name');
        return ('Your $amount landed', name == null ? 'It has arrived' : '$name has it now');
      case 'receive':
        return (first == null ? 'Money received' : '$first sent you money', '$amount landed');
      default:
        final d = e.description.trim();
        return (e.title, d.isEmpty ? amount : d);
    }
  }

  static String _initials(String s) {
    final words = s.replaceAll(RegExp(r'[^A-Za-z ]'), ' ').trim().split(RegExp(r'\s+'));
    if (words.isEmpty || words.first.isEmpty) return 'EB';
    return (words.length == 1 ? words.first.substring(0, words.first.length.clamp(0, 2)) : '${words[0][0]}${words[1][0]}')
        .toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    final (title, subtitle) = _words();
    final e = entry;
    final Widget badge;
    if (e.personName != null) {
      badge = ActivityThumb(entry: e, size: 40);
    } else {
      // Evabob's own news on blue; anything else as its initials.
      final ours = e.kind == 'system';
      badge = Container(
        width: 40,
        height: 40,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: ours ? EvabobColors.blue : EvabobColors.pageBg,
          shape: BoxShape.circle,
        ),
        child: Text(
          ours ? 'EB' : _initials(e.title),
          style: TextStyle(
            fontFamily: 'Inter',
            fontWeight: FontWeight.w900,
            fontSize: 14,
            height: 18 / 14,
            color: ours ? EvabobColors.white : EvabobColors.blue,
          ),
        ),
      );
    }
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        height: 72,
        child: Row(
          children: [
            SizedBox(
              width: 24,
              child: unread
                  ? Center(
                      child: CircleAvatar(
                        radius: 3,
                        backgroundColor: EvabobColors.blue,
                      ),
                    )
                  : null,
            ),
            badge,
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.body.copyWith(letterSpacing: -0.4),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.label.copyWith(color: EvabobColors.slate),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Padding(
              padding: const EdgeInsets.only(right: 16, bottom: 18),
              child: Text(
                time,
                style: Type.label.copyWith(color: EvabobColors.inkTertiary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
