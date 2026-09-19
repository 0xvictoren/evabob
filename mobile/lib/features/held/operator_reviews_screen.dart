import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/held/operator_reviews_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/confirm_action_dialog.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'review_conversation.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

String _day(DateTime? t) =>
    t == null ? '—' : DateFormat('EEE d MMM, HH:mm').format(t.toLocal());

/// Operators only: jobs cancelled after delivery, waiting for a person.
///
/// Reachable from Profile when the server says this account is an operator,
/// and from a "review needed" notification.
class OperatorReviewsScreen extends StatefulWidget {
  const OperatorReviewsScreen({super.key});

  @override
  State<OperatorReviewsScreen> createState() => _OperatorReviewsScreenState();
}

class _OperatorReviewsScreenState extends State<OperatorReviewsScreen> {
  late final OperatorReviewsApi _api =
      OperatorReviewsApi(context.read<ApiClient>());
  List<OperatorReview>? _items;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final items = await _api.listOpen();
      if (mounted) setState(() => (_items = items, _error = null));
    } catch (e) {
      if (mounted) {
        setState(() => _error = friendlyError(
              e,
              fallback: 'Could not load reviews. Pull down to try again.',
            ));
      }
    }
  }

  Future<void> _open(OperatorReview r) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => OperatorReviewDetailScreen(transferId: r.transferId),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Reviews',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(
                      Space.page, 0, Space.page, Space.xl),
                  children: [
                    Text(
                      'Jobs the payer cancelled after the work was marked '
                      'delivered. Nothing moves until you decide.',
                      style:
                          Type.caption.copyWith(color: EvabobColors.navyMuted),
                    ),
                    const SizedBox(height: Space.md),
                    if (items == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 60),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 60),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (items != null && items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 60),
                        child: Text(
                          'Nothing waiting for review.',
                          textAlign: TextAlign.center,
                          style:
                              Type.body.copyWith(color: EvabobColors.navyMuted),
                        ),
                      ),
                    for (final r in items ?? const <OperatorReview>[])
                      Padding(
                        padding: const EdgeInsets.only(bottom: Space.sm),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(12),
                          onTap: () => _open(r),
                          child: Glass(
                            child: Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        '${formatMoney(r.amountUsdc)} · '
                                        '${r.payer} → ${r.recipient}',
                                        style: Type.body.copyWith(
                                            color: EvabobColors.nearBlack),
                                      ),
                                      const SizedBox(height: 2),
                                      Text(
                                        '${r.review.reason?.label ?? 'Cancelled'}'
                                        ' · opened ${_day(r.review.openedAt)}',
                                        style: Type.caption.copyWith(
                                            color: EvabobColors.navyMuted),
                                      ),
                                      Text(
                                        (r.review.workerStatement ?? '').isEmpty
                                            ? 'Worker has not answered yet'
                                            : 'Worker has answered',
                                        style: Type.caption.copyWith(
                                          color:
                                              (r.review.workerStatement ?? '')
                                                      .isEmpty
                                                  ? EvabobColors.danger
                                                  : EvabobColors.navyMuted,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const Icon(Icons.chevron_right_rounded,
                                    color: EvabobColors.inkTertiary),
                              ],
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

/// One review: both sides, the work, the written rule, and the decision.
class OperatorReviewDetailScreen extends StatefulWidget {
  const OperatorReviewDetailScreen({super.key, required this.transferId});

  final String transferId;

  @override
  State<OperatorReviewDetailScreen> createState() =>
      _OperatorReviewDetailScreenState();
}

class _OperatorReviewDetailScreenState
    extends State<OperatorReviewDetailScreen> {
  late final OperatorReviewsApi _api =
      OperatorReviewsApi(context.read<ApiClient>());
  OperatorReview? _review;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await _api.get(widget.transferId);
      if (mounted) setState(() => (_review = r, _error = null));
    } catch (e) {
      if (mounted) {
        setState(() =>
            _error = friendlyError(e, fallback: 'Could not load this review.'));
      }
    }
  }

  Future<void> _decide(OperatorReview r, {required bool release}) async {
    final note = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _DecisionNoteSheet(release: release, review: r),
    );
    if (note == null || !mounted) return;
    final ok = await confirmAction(
      context,
      title: release
          ? 'Pay ${r.recipient} ${formatMoney(r.amountUsdc)}?'
          : 'Return ${formatMoney(r.amountUsdc)} to ${r.payer}?',
      message: 'This moves the money now and cannot be undone. Both people '
          'see your note.',
      confirmLabel: release ? 'Pay the worker' : 'Return to the payer',
      destructive: !release,
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    try {
      await _api.decide(r.transferId, release: release, note: note);
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text(release
              ? 'Paid ${r.recipient}. Both people have been told.'
              : 'Returned to ${r.payer}. Both people have been told.'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      await _load();
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text(friendlyError(e, fallback: 'That did not go through.')),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = _review;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Review',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(
                      Space.page, 0, Space.page, Space.xl),
                  children: [
                    if (r == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 60),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null && r == null)
                      Padding(
                        padding: const EdgeInsets.only(top: 60),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (r != null) ..._body(r),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(OperatorReview r) {
    Widget card(String title, List<Widget> children) => Padding(
          padding: const EdgeInsets.only(bottom: Space.md),
          child: Glass(
            padding: const EdgeInsets.all(Space.lg),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: Type.label.copyWith(color: EvabobColors.nearBlack)),
                const SizedBox(height: Space.xs),
                ...children,
              ],
            ),
          ),
        );
    Text body(String s) =>
        Text(s, style: Type.body.copyWith(color: EvabobColors.nearBlack));
    Text muted(String s) =>
        Text(s, style: Type.caption.copyWith(color: EvabobColors.navyMuted));
    List<Widget> links(List<String> ls) => [
          for (final l in ls)
            SelectableText(l,
                style: Type.caption.copyWith(color: EvabobColors.blue)),
        ];

    final decided = !r.open;
    return [
      card(formatMoney(r.amountUsdc), [
        body('${r.payer} held this for ${r.recipient}.'),
        if (r.memo.isNotEmpty) muted('“${r.memo}”'),
        muted('Hold expires ${_day(r.expiresAt)}'),
      ]),
      card('The work — delivered ${_day(r.deliveredAt)}', [
        body((r.deliveryNote ?? '').isEmpty ? 'No note.' : r.deliveryNote!),
        ...links(r.deliveryLinks),
      ]),
      card('The payer · ${r.review.reason?.label ?? 'cancelled'}', [
        body(r.review.details),
        ...links(r.review.payerLinks),
      ]),
      card('The worker', [
        body((r.review.workerStatement ?? '').isEmpty
            ? 'Has not added their side yet.'
            : r.review.workerStatement!),
        ...links(r.review.workerLinks),
      ]),
      Padding(
        padding: const EdgeInsets.only(bottom: Space.md),
        child: ReviewConversation(
          messages: r.review.messages,
          me: 'reviewer',
          open: r.open,
          onSend: (text, links, photos) async {
            final updated = await _api.sendMessage(
              r.transferId,
              text: text,
              links: links,
              photos: photos,
            );
            if (mounted) setState(() => _review = updated);
          },
        ),
      ),
      card('How to decide (docs/HELD_PAYMENTS.md)', [
        muted('1. Evidence of delivery that matches the invoice → the worker.'),
        muted('2. Specific, checkable differences from what was agreed, or '
            'nothing delivered → the payer.'),
        muted('3. "I no longer need it" after delivery is not a reason to take '
            'back payment for work that was done.'),
        muted('4. Genuinely unclear → the default after delivery: the worker '
            'is paid.'),
        muted('All of it goes one way; a hold cannot be split.'),
      ]),
      if (decided)
        card('Decided', [
          body(switch (r.review.status) {
            'released_to_worker' => 'The money went to the worker.',
            'refunded_to_payer' => 'The money went back to the payer.',
            _ => 'This payment is settled.',
          }),
          if ((r.review.decisionNote ?? '').isNotEmpty)
            muted(r.review.decisionNote!),
        ])
      else if (_busy)
        const Center(child: CircularProgressIndicator())
      else ...[
        SizedBox(
          height: 52,
          child: FilledButton(
            onPressed: () => _decide(r, release: true),
            child: Text('Pay the worker (${r.recipient})'),
          ),
        ),
        const SizedBox(height: Space.sm),
        SizedBox(
          height: 52,
          child: OutlinedButton(
            onPressed: () => _decide(r, release: false),
            child: Text('Return to the payer (${r.payer})'),
          ),
        ),
      ],
    ];
  }
}

/// The decision note. Required, and shown to both people, so it must say why.
class _DecisionNoteSheet extends StatefulWidget {
  const _DecisionNoteSheet({required this.release, required this.review});

  final bool release;
  final OperatorReview review;

  @override
  State<_DecisionNoteSheet> createState() => _DecisionNoteSheetState();
}

class _DecisionNoteSheetState extends State<_DecisionNoteSheet> {
  final _note = TextEditingController();
  String? _problem;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  void _submit() {
    final note = _note.text.trim();
    if (note.length < 10) {
      setState(() => _problem = 'Write down why — both people will read it');
      return;
    }
    Navigator.pop(context, note);
  }

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
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                widget.release ? 'Why the worker is paid' : 'Why it goes back',
                style: Type.title.copyWith(color: EvabobColors.nearBlack),
              ),
              const SizedBox(height: Space.sm),
              Text(
                'Both ${widget.review.payer} and ${widget.review.recipient} '
                'see this. Your name is not shown.',
                style: Type.caption.copyWith(color: EvabobColors.navyMuted),
              ),
              const SizedBox(height: Space.md),
              TextField(
                controller: _note,
                maxLength: 1000,
                minLines: 3,
                maxLines: 6,
                decoration: const InputDecoration(labelText: 'Decision note'),
              ),
              if (_problem != null)
                Text(_problem!,
                    style: Type.caption.copyWith(color: EvabobColors.alert)),
              const SizedBox(height: Space.md),
              SizedBox(
                height: 52,
                child: FilledButton(
                  onPressed: _submit,
                  child: const Text('Continue'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
