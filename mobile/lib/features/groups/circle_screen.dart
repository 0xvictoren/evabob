import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/groups/groups_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';

/// One money circle: where it is, who is next, who is behind, and joining.
class CircleScreen extends StatefulWidget {
  const CircleScreen({super.key, required this.circleId});

  final String circleId;

  @override
  State<CircleScreen> createState() => _CircleScreenState();
}

class _CircleScreenState extends State<CircleScreen> {
  late final GroupsApi _api = GroupsApi(context.read<ApiClient>());
  MoneyCircle? _circle;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final g = await _api.get(widget.circleId);
      if (!mounted) return;
      setState(() {
        _circle = g is CircleGroup ? g.circle : null;
        _error = g is CircleGroup ? null : 'That is not a circle.';
      });
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  Future<void> _join(MoneyCircle c) async {
    final ok = await confirmPayment(
      context,
      PaymentReview(
        payeeLabel: 'Joining',
        payee: c.name,
        amount: c.contributionUsdc,
        action: 'Join',
        landedLabel: 'You take home, on your turn',
        landedAmount: c.potUsdc,
        feeFrom: 'the payout',
        warning: 'Nothing leaves your balance today. You allow the circle to '
            'collect ${formatMoney(c.contributionUsdc)} ${c.everyWords}, '
            '${c.rounds} times in all (${formatMoney(c.commitmentUsdc)}). '
            'If it cannot collect one round, the round still pays out, you '
            'are marked behind, and your own turn moves to the end until '
            'you catch up.',
        note: 'The circle starts when everyone has joined.',
      ),
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    try {
      final res = await context
          .read<CircleWalletService>()
          .joinCircle(context: context, circleId: c.id);
      if (!mounted) return;
      if (res['ok'] != true) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(friendlyError(res['error'],
              fallback: 'You were not added to the circle.')),
          behavior: SnackBarBehavior.floating,
        ));
      }
      await _load();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _circle;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: c?.name ?? 'Money circle',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: c == null
                  ? Center(
                      child: _error == null
                          ? const CircularProgressIndicator()
                          : Text(_error!, textAlign: TextAlign.center),
                    )
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(
                            Space.page, 0, Space.page, Space.xl),
                        children: _body(c),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(MoneyCircle c) {
    final df = DateFormat('EEE d MMM, HH:mm');
    final me = c.me;
    final headline = switch (c.state) {
      'forming' =>
        '${c.members.where((m) => m.joined).length} of ${c.members.length} have joined',
      'running' => 'Round ${c.roundsCollected + 1} of ${c.rounds}',
      'finished' => 'Everyone has had their turn',
      _ => 'Called off before it started',
    };
    return [
      Glass(
        heavy: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${formatMoney(c.contributionUsdc)} ${c.everyWords}',
              style: Type.title.copyWith(color: EvabobColors.nearBlack),
            ),
            Text(
              'Each round one person takes ${formatMoney(c.potUsdc)}.',
              style: Type.body.copyWith(color: EvabobColors.navyMuted),
            ),
            const SizedBox(height: Space.md),
            LinearProgressIndicator(
              value: c.rounds == 0 ? 0 : c.roundsCollected / c.rounds,
              minHeight: 8,
              borderRadius: BorderRadius.circular(99),
              backgroundColor: EvabobColors.sand,
            ),
            const SizedBox(height: Space.sm),
            Text(headline,
                style: Type.body.copyWith(color: EvabobColors.nearBlack)),
            if (c.state == 'running' && c.nextCollectionAt != null)
              Text(
                'Next collection ${df.format(c.nextCollectionAt!.toLocal())}',
                style: Type.caption.copyWith(color: EvabobColors.navyMuted),
              ),
            Text('Organised by ${c.organizer}',
                style: Type.caption.copyWith(color: EvabobColors.navyMuted)),
          ],
        ),
      ),
      if (me != null && me.behind) ...[
        const SizedBox(height: Space.md),
        Container(
          padding: const EdgeInsets.all(Space.md),
          decoration: BoxDecoration(
            color: EvabobColors.danger.withValues(alpha: 0.1),
            borderRadius: Radii.all(Radii.md),
          ),
          child: Text(
            'You are ${formatMoney(me.behindUsdc)} behind. Add money to your '
            'balance and it is paid to whoever you missed, automatically. '
            'Until then your turn waits at the end.',
            style: Type.body.copyWith(color: EvabobColors.nearBlack),
          ),
        ),
      ],
      if (c.needsMyJoin) ...[
        const SizedBox(height: Space.lg),
        SizedBox(
          height: 54,
          child: FilledButton(
            onPressed: _busy ? null : () => _join(c),
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Join the circle'),
          ),
        ),
      ],
      const SizedBox(height: Space.lg),
      const EvabobSectionLabel('Payout order'),
      const SizedBox(height: Space.sm),
      for (final m in [...c.members]..sort(_byTurn))
        Padding(
          padding: const EdgeInsets.only(bottom: Space.xs),
          child: Glass(
            child: Row(
              children: [
                SizedBox(
                  width: 28,
                  child: m.paid
                      ? const Icon(Icons.check_circle_rounded,
                          size: 20, color: EvabobColors.emeraldDeep)
                      : Text('${m.place ?? ''}',
                          style: Type.body
                              .copyWith(color: EvabobColors.navyMuted)),
                ),
                Expanded(
                  child: Text(
                    m.userId == me?.userId ? '${m.name} (you)' : m.name,
                    style: Type.body.copyWith(color: EvabobColors.nearBlack),
                  ),
                ),
                Text(
                  m.paid
                      ? 'Got ${formatMoney(m.paidUsdc ?? 0)} · round ${m.paidRound}'
                      : !m.joined && c.state == 'forming'
                          ? 'Not joined yet'
                          : m.behind
                              ? '${formatMoney(m.behindUsdc)} behind'
                              : m.place == 1 && c.state == 'running'
                                  ? 'Next'
                                  : 'Waiting',
                  style: Type.caption.copyWith(
                    color: m.behind
                        ? EvabobColors.danger
                        : EvabobColors.navyMuted,
                  ),
                ),
              ],
            ),
          ),
        ),
      if (c.history.isNotEmpty) ...[
        const SizedBox(height: Space.lg),
        const EvabobSectionLabel('Rounds'),
        const SizedBox(height: Space.sm),
        for (final h in c.history.reversed)
          Padding(
            padding: const EdgeInsets.only(bottom: Space.xs),
            child: Text(
              'Round ${h.round}: ${h.recipient} received '
              '${formatMoney(h.amountUsdc)} · ${df.format(h.at.toLocal())}'
              '${h.missed.isEmpty ? '' : ' · missed: ${h.missed.join(', ')}'}',
              style: Type.caption.copyWith(color: EvabobColors.navyMuted),
            ),
          ),
      ],
      const SizedBox(height: Space.lg),
      Text(
        'Nobody holds this money. Each round the circle collects from '
        'everyone and pays the next person in the same moment. Evabob takes '
        '0.05% of each payout.',
        style: Type.caption.copyWith(color: EvabobColors.navyMuted),
      ),
    ];
  }

  /// Paid first (by round), then the queue in order.
  static int _byTurn(CircleMember a, CircleMember b) {
    if (a.paid && b.paid) return a.paidRound!.compareTo(b.paidRound!);
    if (a.paid) return -1;
    if (b.paid) return 1;
    return (a.place ?? 99).compareTo(b.place ?? 99);
  }
}
