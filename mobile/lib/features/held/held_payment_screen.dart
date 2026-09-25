import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/api/api_client.dart';
import '../../core/held/held_payments_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/confirm_action_dialog.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'review_conversation.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// One held payment: where it stands, what happens next, and what this person
/// can do about it.
///
/// The rules it explains are the product's, written down before the first
/// dispute (docs/HELD_PAYMENTS.md): the worker marks the work delivered, the
/// payer has 7 days to check it, silence pays the worker, and a cancellation
/// after delivery goes to a person who reads both sides.
class HeldPaymentScreen extends StatefulWidget {
  const HeldPaymentScreen({super.key, required this.transferId, this.onBack});

  final String transferId;
  final VoidCallback? onBack;

  @override
  State<HeldPaymentScreen> createState() => _HeldPaymentScreenState();
}

class _HeldPaymentScreenState extends State<HeldPaymentScreen> {
  late final HeldPaymentsApi _api = HeldPaymentsApi(context.read<ApiClient>());
  HeldPayment? _hold;
  String? _error;
  bool _busy = false;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final hold = await _api.get(widget.transferId);
      if (!mounted) return;
      setState(() {
        _hold = hold;
        _error = null;
      });
      _scheduleTick(hold);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = friendlyError(
            e,
            fallback: 'Could not load this payment. Pull down to try again.',
          ));
    }
  }

  /// A cooling-off payment shows a live countdown and is re-read when it ends,
  /// which is also what prompts the server to send it.
  void _scheduleTick(HeldPayment hold) {
    _tick?.cancel();
    final end = hold.releaseAt;
    if (!hold.isCoolingOff || hold.stage.settled || end == null) return;
    _tick = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      if (DateTime.now().isAfter(end.add(const Duration(seconds: 3)))) {
        t.cancel();
        _load();
      } else {
        setState(() {});
      }
    });
  }

  Future<void> _run(Future<HeldPayment> Function() action, String done) async {
    setState(() => _busy = true);
    try {
      final hold = await action();
      if (!mounted) return;
      setState(() => _hold = hold);
      _scheduleTick(hold);
      _snack(done);
      await _refreshMoney();
    } catch (e) {
      if (mounted) {
        _snack(
            friendlyError(e, fallback: 'That did not go through. Try again.'));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refreshMoney() async {
    try {
      await context.read<ActivityService>().refresh();
      if (!mounted) return;
      await context
          .read<WalletService>()
          .refreshBalances(force: true, silent: true);
    } catch (_) {}
  }

  void _snack(String text) {
    showTopSnack(
      context,
      SnackBar(content: Text(text), behavior: SnackBarBehavior.floating),
    );
  }

  // ─── Actions ──────────────────────────────────────────────────────────

  Future<void> _confirm(HeldPayment h) async {
    final ok = await confirmAction(
      context,
      title: 'Pay ${h.counterparty} now?',
      message: '${formatMoney(h.amountUsdc)} reaches them straight away. '
          'You cannot get it back afterwards.',
      confirmLabel: 'Pay now',
    );
    if (!ok || !mounted) return;
    await _run(() => _api.confirm(h.transferId), 'Sent to ${h.counterparty}');
  }

  Future<void> _cancel(HeldPayment h) async {
    final ok = await confirmAction(
      context,
      title:
          h.isCoolingOff ? 'Cancel this payment?' : 'Cancel and get it back?',
      message: h.isCoolingOff
          ? '${formatMoney(h.amountUsdc)} comes straight back to you and '
              '${h.counterparty} gets nothing.'
          : '${formatMoney(h.amountUsdc)} comes straight back to you. '
              '${h.counterparty} will be told.',
      confirmLabel: h.isCoolingOff ? 'Cancel payment' : 'Cancel it',
      destructive: true,
    );
    if (!ok || !mounted) return;
    await _run(
      () async => (await _api.cancel(h.transferId)).hold,
      'Cancelled — the money is back with you',
    );
  }

  Future<void> _cancelWithReason(HeldPayment h) async {
    final form = await showModalBottomSheet<_CancelForm>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _CancelFormSheet(counterparty: h.counterparty),
    );
    if (form == null || !mounted) return;
    await _run(
      () async => (await _api.cancel(
        h.transferId,
        reason: form.reason,
        details: form.details,
        links: form.links,
      ))
          .hold,
      'Sent for review. The money stays put until it is decided.',
    );
  }

  Future<void> _markDelivered(HeldPayment h) async {
    final form = await showModalBottomSheet<_TextForm>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _TextFormSheet(
        title: 'Mark the work as delivered',
        intro: '${h.counterparty} then has 7 days to check it. If they do not '
            'raise a problem, the money comes to you automatically.',
        fieldLabel: 'What did you deliver?',
        minLength: 3,
        submitLabel: 'Mark as delivered',
      ),
    );
    if (form == null || !mounted) return;
    await _run(
      () =>
          _api.markDelivered(h.transferId, note: form.text, links: form.links),
      'Marked as delivered. We told ${h.counterparty}.',
    );
  }

  Future<void> _respond(HeldPayment h) async {
    final form = await showModalBottomSheet<_TextForm>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const _TextFormSheet(
        title: 'Add your side',
        intro: 'A person at Evabob reads both sides before deciding. Say what '
            'you delivered and when, and add links to the work if you can.',
        fieldLabel: 'What happened',
        minLength: 20,
        submitLabel: 'Send',
      ),
    );
    if (form == null || !mounted) return;
    await _run(
      () => _api.respond(h.transferId, statement: form.text, links: form.links),
      'Thanks — your side is with the reviewer',
    );
  }

  Future<void> _giveBack(HeldPayment h) async {
    final ok = await confirmAction(
      context,
      title: 'Return the money?',
      message: '${formatMoney(h.amountUsdc)} goes back to ${h.counterparty} '
          'straight away. This settles it.',
      confirmLabel: 'Return it',
      destructive: true,
    );
    if (!ok || !mounted) return;
    await _run(
        () => _api.giveBack(h.transferId), 'Returned to ${h.counterparty}');
  }

  // ─── View ─────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final h = _hold;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: h == null
                    ? 'Held payment'
                    : h.isCoolingOff
                        ? 'Payment'
                        : 'Held payment',
                onBack: widget.onBack ?? () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(
                      Space.page, 0, Space.page, Space.xl),
                  children: [
                    if (h == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 80),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null && h == null)
                      Padding(
                        padding: const EdgeInsets.only(top: 80),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (h != null) ..._body(h),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(HeldPayment h) {
    final (headline, explain) = _words(h);
    return [
      Glass(
        padding: const EdgeInsets.all(Space.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              formatMoney(h.amountUsdc),
              style: Type.hero.copyWith(
                fontSize: 40,
                color: EvabobColors.nearBlack,
              ),
            ),
            const SizedBox(height: Space.xs),
            Text(headline,
                style: Type.title.copyWith(color: EvabobColors.nearBlack)),
            const SizedBox(height: Space.sm),
            Text(explain,
                style: Type.body.copyWith(color: EvabobColors.navyMuted)),
            if (h.memo.isNotEmpty) ...[
              const SizedBox(height: Space.md),
              Text('“${h.memo}”',
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted)),
            ],
          ],
        ),
      ),
      if (h.payerAgent != null && !h.isPayer) ...[
        const SizedBox(height: Space.md),
        Glass(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.lock_clock_outlined,
                  color: EvabobColors.emeraldDeep),
              const SizedBox(width: Space.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('The money is set aside before you start',
                        style:
                            Type.body.copyWith(color: EvabobColors.nearBlack)),
                    const SizedBox(height: 2),
                    Text(
                      '${h.payerAgent!.byline} hired you, and the fee is '
                      'locked for you. Mark the work delivered and it is '
                      'yours within 7 days, unless the agent disputes it and '
                      'the person who reviews it agrees.',
                      style:
                          Type.caption.copyWith(color: EvabobColors.navyMuted),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
      if (h.isCoolingOff && h.stage == HeldStage.coolingOff) ...[
        const SizedBox(height: Space.md),
        _Countdown(until: h.releaseAt),
      ],
      if (h.isJob && h.deliveredAt != null) ...[
        const SizedBox(height: Space.md),
        _Section(
          title: 'Delivered ${_day(h.deliveredAt)}',
          text: h.deliveryNote ?? '',
          links: h.deliveryLinks,
        ),
      ],
      if (h.review != null) ...[
        const SizedBox(height: Space.md),
        _ReviewCard(review: h.review!, isPayer: h.isPayer),
        const SizedBox(height: Space.md),
        ReviewConversation(
          messages: h.review!.messages,
          me: h.role,
          open: h.review!.open,
          onSend: (text, links, photos) async {
            final updated = await _api.sendMessage(
              h.transferId,
              text: text,
              links: links,
              photos: photos,
            );
            if (mounted) setState(() => _hold = updated);
          },
        ),
      ],
      if (h.isJob && !h.stage.settled) ...[
        const SizedBox(height: Space.md),
        _Section(
          title: 'How this works',
          text: 'When the work is done, it is marked as delivered. The payer '
              'then has 7 days to check it. If they do not raise a problem, '
              'the money goes to the worker automatically. Cancelling after '
              'delivery goes to a person at Evabob, who reads both sides.',
        ),
      ],
      const SizedBox(height: Space.lg),
      if (_busy)
        const Center(child: CircularProgressIndicator())
      else
        ..._buttons(h),
    ];
  }

  List<Widget> _buttons(HeldPayment h) {
    Widget primary(String label, VoidCallback onTap) => Padding(
          padding: const EdgeInsets.only(bottom: Space.sm),
          child: SizedBox(
            height: 52,
            child: FilledButton(onPressed: onTap, child: Text(label)),
          ),
        );
    Widget secondary(String label, VoidCallback onTap) => Padding(
          padding: const EdgeInsets.only(bottom: Space.sm),
          child: SizedBox(
            height: 52,
            child: OutlinedButton(onPressed: onTap, child: Text(label)),
          ),
        );
    return [
      if (h.can('mark_delivered'))
        primary('Delivered', () => _markDelivered(h)),
      if (h.can('respond')) primary('Add your side', () => _respond(h)),
      if (h.can('confirm')) primary('Pay now', () => _confirm(h)),
      if (h.can('cancel'))
        secondary(
          h.isCoolingOff ? 'Cancel payment' : 'Cancel and get it back',
          () => _cancel(h),
        ),
      if (h.can('cancel_with_reason'))
        secondary('Something is wrong', () => _cancelWithReason(h)),
      if (h.can('give_back'))
        secondary('Return the money', () => _giveBack(h)),
    ];
  }

  /// Headline and one plain explanation, per stage and per side.
  (String, String) _words(HeldPayment h) {
    final who = h.counterparty;
    final release = _day(h.autoReleaseAt);
    switch (h.stage) {
      case HeldStage.waitingForDelivery:
        return h.isPayer
            ? (
                'Held for $who until the work arrives',
                'The money has left your balance but is not theirs yet. You '
                    'can cancel and get it back until they mark it delivered.'
              )
            : (
                '$who has set this aside for your work',
                'Mark it as delivered when you are done. They then have 7 '
                    'days to check it.'
              );
      case HeldStage.delivered:
        return h.isPayer
            ? (
                '$who says the work is done',
                'Check it. If you do not raise a problem, it goes to them on '
                    '$release.'
              )
            : (
                'Waiting for $who to check your work',
                'If they do not raise a problem, it is yours on $release.'
              );
      case HeldStage.underReview:
        return h.isPayer
            ? (
                'Being reviewed',
                'You cancelled after the work was marked delivered. A person '
                    'at Evabob is reading both sides. The money stays put until '
                    'then.'
              )
            : (
                '$who cancelled after you delivered',
                'A person at Evabob will read both sides. The money stays put '
                    'until then. Add your side so they have it.'
              );
      case HeldStage.coolingOff:
        return (
          'Sending to $who',
          'You chose to wait before this goes, in case something is not '
              'right. You can cancel until the timer runs out.'
        );
      case HeldStage.waitingToClaim:
        return (
          'Waiting for $who to join',
          'They get it when they sign up. If they have not by '
              '${_day(h.expiresAt)}, it comes back to you.'
        );
      case HeldStage.released:
        return h.isPayer
            ? ('Sent to $who', 'This payment is settled.')
            : ('Paid', 'The money is in your balance.');
      case HeldStage.refunded:
        return h.isPayer
            ? ('Back with you', 'The money returned to your balance.')
            : ('Went back to $who', 'This payment is settled.');
      case HeldStage.unknown:
        return ('Held payment', '');
    }
  }
}

String _day(DateTime? t) =>
    t == null ? 'soon' : DateFormat('EEE d MMM').format(t.toLocal());

class _Countdown extends StatelessWidget {
  const _Countdown({required this.until});

  final DateTime? until;

  @override
  Widget build(BuildContext context) {
    final left = until?.difference(DateTime.now()) ?? Duration.zero;
    final done = left.isNegative || left == Duration.zero;
    final mm = left.inMinutes.remainder(60).toString().padLeft(2, '0');
    final ss = left.inSeconds.remainder(60).toString().padLeft(2, '0');
    return Glass(
      padding: const EdgeInsets.all(Space.lg),
      child: Row(
        children: [
          Icon(Icons.timer_outlined, color: EvabobColors.blue),
          const SizedBox(width: Space.md),
          Expanded(
            child: Text(
              done ? 'Sending now…' : 'Goes in $mm:$ss',
              style: Type.title.copyWith(color: EvabobColors.nearBlack),
            ),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(
      {required this.title, required this.text, this.links = const []});

  final String title;
  final String text;
  final List<String> links;

  @override
  Widget build(BuildContext context) {
    return Glass(
      padding: const EdgeInsets.all(Space.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title,
              style: Type.label.copyWith(color: EvabobColors.nearBlack)),
          if (text.isNotEmpty) ...[
            const SizedBox(height: Space.xs),
            Text(text,
                style: Type.body.copyWith(color: EvabobColors.navyMuted)),
          ],
          for (final l in links) ...[
            const SizedBox(height: Space.xs),
            SelectableText(l,
                style: Type.caption.copyWith(color: EvabobColors.blue)),
          ],
        ],
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.review, required this.isPayer});

  final HeldReview review;
  final bool isPayer;

  @override
  Widget build(BuildContext context) {
    final outcome = switch (review.status) {
      'released_to_worker' => 'Decided: the money went to the worker.',
      'refunded_to_payer' => 'Decided: the money went back to the payer.',
      _ => 'A person at Evabob is reviewing this.',
    };
    return Glass(
      padding: const EdgeInsets.all(Space.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Review',
              style: Type.label.copyWith(color: EvabobColors.nearBlack)),
          const SizedBox(height: Space.xs),
          Text(outcome,
              style: Type.body.copyWith(color: EvabobColors.nearBlack)),
          if ((review.decisionNote ?? '').isNotEmpty) ...[
            const SizedBox(height: Space.xs),
            Text(review.decisionNote!,
                style: Type.body.copyWith(color: EvabobColors.navyMuted)),
          ],
          const SizedBox(height: Space.md),
          Text(
            'The payer: ${review.reason?.label ?? 'cancelled'}',
            style: Type.caption.copyWith(color: EvabobColors.navyMuted),
          ),
          Text(review.details,
              style: Type.body.copyWith(color: EvabobColors.nearBlack)),
          for (final l in review.payerLinks)
            SelectableText(l,
                style: Type.caption.copyWith(color: EvabobColors.blue)),
          const SizedBox(height: Space.md),
          Text('The worker',
              style: Type.caption.copyWith(color: EvabobColors.navyMuted)),
          Text(
            (review.workerStatement ?? '').isEmpty
                ? (isPayer
                    ? 'Has not added their side yet.'
                    : 'You have not added your side yet.')
                : review.workerStatement!,
            style: Type.body.copyWith(color: EvabobColors.nearBlack),
          ),
          for (final l in review.workerLinks)
            SelectableText(l,
                style: Type.caption.copyWith(color: EvabobColors.blue)),
        ],
      ),
    );
  }
}

// ─── Forms ──────────────────────────────────────────────────────────────

class _TextForm {
  const _TextForm(this.text, this.links);
  final String text;
  final List<String> links;
}

List<String> _parseLinks(String raw) => raw
    .split(RegExp(r'[\s,]+'))
    .map((s) => s.trim())
    .where((s) => s.isNotEmpty)
    .toList(growable: false);

String? _linksProblem(List<String> links) {
  if (links.length > 5) return 'Add at most 5 links';
  for (final l in links) {
    if (!RegExp(r'^https?://\S{3,}$', caseSensitive: false).hasMatch(l)) {
      return '"$l" is not a web link';
    }
  }
  return null;
}

class _SheetFrame extends StatelessWidget {
  const _SheetFrame({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding:
          EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        top: false,
        child: Container(
          margin: const EdgeInsets.all(Space.md),
          padding: const EdgeInsets.all(Space.lg),
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.lg),
            boxShadow: Shadows.raised,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: children,
            ),
          ),
        ),
      ),
    );
  }
}

class _TextFormSheet extends StatefulWidget {
  const _TextFormSheet({
    required this.title,
    required this.intro,
    required this.fieldLabel,
    required this.minLength,
    required this.submitLabel,
  });

  final String title;
  final String intro;
  final String fieldLabel;
  final int minLength;
  final String submitLabel;

  @override
  State<_TextFormSheet> createState() => _TextFormSheetState();
}

class _TextFormSheetState extends State<_TextFormSheet> {
  final _text = TextEditingController();
  final _links = TextEditingController();
  String? _problem;

  @override
  void dispose() {
    _text.dispose();
    _links.dispose();
    super.dispose();
  }

  void _submit() {
    final text = _text.text.trim();
    final links = _parseLinks(_links.text);
    final problem = text.length < widget.minLength
        ? 'Write a little more so the other person understands'
        : _linksProblem(links);
    if (problem != null) {
      setState(() => _problem = problem);
      return;
    }
    Navigator.pop(context, _TextForm(text, links));
  }

  @override
  Widget build(BuildContext context) {
    return _SheetFrame(children: [
      Text(widget.title,
          style: Type.title.copyWith(color: EvabobColors.nearBlack)),
      const SizedBox(height: Space.sm),
      Text(widget.intro,
          style: Type.body.copyWith(color: EvabobColors.navyMuted)),
      const SizedBox(height: Space.lg),
      TextField(
        controller: _text,
        maxLength: 500,
        minLines: 3,
        maxLines: 6,
        decoration: InputDecoration(labelText: widget.fieldLabel),
      ),
      TextField(
        controller: _links,
        minLines: 1,
        maxLines: 3,
        keyboardType: TextInputType.url,
        decoration: const InputDecoration(
          labelText: 'Links (optional)',
          hintText: 'One per line, e.g. a shared folder',
        ),
      ),
      if (_problem != null) ...[
        const SizedBox(height: Space.sm),
        Text(_problem!,
            style: Type.caption.copyWith(color: EvabobColors.alert)),
      ],
      const SizedBox(height: Space.lg),
      SizedBox(
        height: 52,
        child:
            FilledButton(onPressed: _submit, child: Text(widget.submitLabel)),
      ),
    ]);
  }
}

class _CancelForm {
  const _CancelForm(this.reason, this.details, this.links);
  final CancelReason reason;
  final String details;
  final List<String> links;
}

/// The reconciliation form: a payer cancelling after delivery says why, and a
/// person reads it alongside the worker's side before deciding.
class _CancelFormSheet extends StatefulWidget {
  const _CancelFormSheet({required this.counterparty});

  final String counterparty;

  @override
  State<_CancelFormSheet> createState() => _CancelFormSheetState();
}

class _CancelFormSheetState extends State<_CancelFormSheet> {
  CancelReason? _reason;
  final _details = TextEditingController();
  final _links = TextEditingController();
  String? _problem;

  @override
  void dispose() {
    _details.dispose();
    _links.dispose();
    super.dispose();
  }

  void _submit() {
    final details = _details.text.trim();
    final links = _parseLinks(_links.text);
    final problem = _reason == null
        ? 'Choose why you no longer need the work'
        : details.length < 20
            ? 'Tell us what happened in a sentence or two — a person reads this'
            : _linksProblem(links);
    if (problem != null) {
      setState(() => _problem = problem);
      return;
    }
    Navigator.pop(context, _CancelForm(_reason!, details, links));
  }

  @override
  Widget build(BuildContext context) {
    return _SheetFrame(children: [
      Text('Why do you no longer need it?',
          style: Type.title.copyWith(color: EvabobColors.nearBlack)),
      const SizedBox(height: Space.sm),
      Text(
        '${widget.counterparty} has marked the work as delivered, so this goes '
        'to a person at Evabob. They read what you write here and what '
        '${widget.counterparty} says, then decide where the money goes. '
        'Nothing moves until they do.',
        style: Type.body.copyWith(color: EvabobColors.navyMuted),
      ),
      const SizedBox(height: Space.md),
      RadioGroup<CancelReason>(
        groupValue: _reason,
        onChanged: (v) => setState(() => _reason = v),
        child: Material(
          type: MaterialType.transparency,
          child: Column(
            children: [
              for (final r in CancelReason.values)
                RadioListTile<CancelReason>(
                  value: r,
                  contentPadding: EdgeInsets.zero,
                  title: Text(r.label),
                ),
            ],
          ),
        ),
      ),
      TextField(
        controller: _details,
        maxLength: 2000,
        minLines: 3,
        maxLines: 6,
        decoration: const InputDecoration(labelText: 'What happened'),
      ),
      TextField(
        controller: _links,
        minLines: 1,
        maxLines: 3,
        keyboardType: TextInputType.url,
        decoration: const InputDecoration(
          labelText: 'Links (optional)',
          hintText: 'Screenshots, messages, the delivered files',
        ),
      ),
      if (_problem != null) ...[
        const SizedBox(height: Space.sm),
        Text(_problem!,
            style: Type.caption.copyWith(color: EvabobColors.alert)),
      ],
      const SizedBox(height: Space.lg),
      SizedBox(
        height: 52,
        child: FilledButton(
            onPressed: _submit, child: const Text('Send for review')),
      ),
    ]);
  }
}
