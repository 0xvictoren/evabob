import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/notifications/money_alerts.dart';
import '../../core/sound/money_sounds.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import '../activity/receipt_sheet.dart';

/// For a seller at the counter: money as it lands, with a sound.
///
/// Leave it open on the phone by the till. Each payment that arrives chimes
/// and slides in at the top, so nobody has to take a customer's screenshot on
/// trust or dig through history while they wait.
class MoneyInScreen extends StatefulWidget {
  const MoneyInScreen({super.key});

  @override
  State<MoneyInScreen> createState() => _MoneyInScreenState();
}

class _MoneyInScreenState extends State<MoneyInScreen> {
  final List<ActivityEntry> _items = [];
  final Set<String> _fresh = {};
  StreamSubscription<Map<String, dynamic>>? _alerts;
  Timer? _poll;
  bool _loading = true;
  bool _sound = MoneySounds.instance.enabled;
  bool _checking = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    // The live alert is the fast path; the poll catches anything it misses.
    _alerts = context.read<MoneyAlerts>().events.listen((a) {
      if (a['kind'] == 'money_in') _checkNew();
    });
    _poll = Timer.periodic(const Duration(seconds: 6), (_) => _checkNew());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _alerts?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final items = await context.read<ActivityService>().incoming();
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(items);
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _checkNew() async {
    if (_checking || _loading) return;
    _checking = true;
    try {
      final since = _items.isEmpty ? null : _items.first.createdAt;
      final fresh =
          await context.read<ActivityService>().incoming(since: since);
      final known = _items.map((e) => e.id).toSet();
      final added = fresh.where((e) => !known.contains(e.id)).toList();
      if (!mounted || added.isEmpty) return;
      setState(() {
        _items.insertAll(0, added);
        _fresh.addAll(added.map((e) => e.id));
        _error = null;
      });
      HapticFeedback.mediumImpact();
      // Same sound, and same payment, as the live alert: it chimes once.
      MoneySounds.instance.playIn(key: added.first.txHash ?? added.first.id);
      // The highlight fades after a while so the next one stands out.
      Timer(const Duration(seconds: 20), () {
        if (mounted) setState(() => _fresh.removeAll(added.map((e) => e.id)));
      });
    } catch (_) {
      // A missed poll is caught by the next one.
    } finally {
      _checking = false;
    }
  }

  bool _isToday(DateTime t) {
    final now = DateTime.now();
    final l = t.toLocal();
    return l.year == now.year && l.month == now.month && l.day == now.day;
  }

  @override
  Widget build(BuildContext context) {
    final today = _items.where((e) => _isToday(e.createdAt)).toList();
    // Dollars and euros are never added together at face value.
    final todayUsd = today
        .where((e) => e.displayToken == 'USDC')
        .fold<double>(0, (s, e) => s + e.displayAmount);
    final todayEur = today
        .where((e) => e.displayToken == 'EURC')
        .fold<double>(0, (s, e) => s + e.displayAmount);
    final time = DateFormat('HH:mm');

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Money in',
                onBack: () => Navigator.of(context).maybePop(),
                trailing: IconButton(
                  tooltip: _sound ? 'Mute the sound' : 'Turn the sound on',
                  onPressed: () {
                    setState(() => _sound = !_sound);
                    MoneySounds.instance.setEnabled(_sound);
                  },
                  icon: Icon(
                    _sound
                        ? Icons.volume_up_rounded
                        : Icons.volume_off_rounded,
                    color: EvabobColors.ink,
                  ),
                ),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(
                      Space.page, 0, Space.page, Space.xl),
                  children: [
                    Glass(
                      heavy: true,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Today',
                              style: Type.caption
                                  .copyWith(color: EvabobColors.navyMuted)),
                          const SizedBox(height: 6),
                          Text(
                            formatMoney(todayUsd),
                            style: const TextStyle(
                              fontSize: 40,
                              color: EvabobColors.ink,
                            ),
                          ),
                          if (todayEur > 0)
                            Text(
                              '+ ${formatMoney(todayEur, 'EURC')}',
                              style: Type.body
                                  .copyWith(color: EvabobColors.navyMuted),
                            ),
                          const SizedBox(height: 6),
                          Row(
                            children: [
                              Container(
                                width: 8,
                                height: 8,
                                decoration: const BoxDecoration(
                                  color: EvabobColors.success,
                                  shape: BoxShape.circle,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  'Listening. Keep this open and you will '
                                  'hear each payment arrive.',
                                  style: Type.caption.copyWith(
                                      color: EvabobColors.navyMuted),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: Space.md),
                    if (_loading)
                      const Padding(
                        padding: EdgeInsets.only(top: 60),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null && _items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (!_loading && _error == null && _items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: Text(
                          'Nothing yet. Payments show here the moment they '
                          'land.',
                          textAlign: TextAlign.center,
                          style:
                              Type.body.copyWith(color: EvabobColors.navyMuted),
                        ),
                      ),
                    for (final e in _items)
                      Padding(
                        padding: const EdgeInsets.only(bottom: Space.sm),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 600),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(16),
                            border: Border.all(
                              color: _fresh.contains(e.id)
                                  ? EvabobColors.primary
                                  : Colors.transparent,
                              width: 2,
                            ),
                          ),
                          child: InkWell(
                            borderRadius: BorderRadius.circular(16),
                            onTap: () => ReceiptSheet.open(context, e),
                            child: Glass(
                              child: Row(
                                children: [
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          shortUiText(
                                            e.sender ?? e.counterparty ?? e.title,
                                            max: 40,
                                          ),
                                          style: Type.body.copyWith(
                                              color: EvabobColors.nearBlack),
                                        ),
                                        Text(
                                          _isToday(e.createdAt)
                                              ? time.format(e.createdAt.toLocal())
                                              : DateFormat('d MMM, HH:mm')
                                                  .format(e.createdAt.toLocal()),
                                          style: Type.caption.copyWith(
                                              color: EvabobColors.navyMuted),
                                        ),
                                      ],
                                    ),
                                  ),
                                  Text(
                                    '+${formatMoney(e.displayAmount, e.displayToken)}',
                                    style: Type.body.copyWith(
                                        color: EvabobColors.emeraldDeep),
                                  ),
                                ],
                              ),
                            ),
                          ),
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
