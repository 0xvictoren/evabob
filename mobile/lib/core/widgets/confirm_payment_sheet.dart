import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../config/app_features.dart';
import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';
import '../utils/money_format.dart';

/// The review step in front of every payment.
///
/// Until this existed, the last place an amount and a recipient appeared
/// together was the button label on the previous screen. The screen where
/// someone actually commits — Circle's PIN sheet — shows a title and the words
/// "Confirm with your PIN", and nothing about the money.
///
/// People arrive at this app believing payments work the way a bank's do:
/// reversible, cancellable, fixable by calling someone. Here they are none of
/// those things, so the one moment where being wrong is permanent has to say
/// so out loud.
class PaymentReview {
  const PaymentReview({
    required this.payee,
    required this.amount,
    this.token = 'USDC',
    this.payeeDetail,
    this.action = 'Send',
    this.firstTime = false,
    this.note,
    this.warning = irreversible,
    this.payeeLabel = 'To',
    this.feeOnTop = true,
    this.tokenDecimals = 6,
    this.cautions = const [],
    this.coolingOffMinutes,
    this.coolingOffDefault = false,
    this.landedAmount,
    this.landedLabel = 'They receive',
    this.payeePhotoUrl,
    this.feeFrom,
  });

  /// When the Evabob fee is taken from what is paid out rather than added on
  /// top — a circle's payout, a collection's release — what it is taken
  /// from, e.g. "the payout". Nothing extra leaves the payer.
  final String? feeFrom;

  /// What actually arrives, when it differs from [amount] — a bridge loses
  /// Circle's small Fast Transfer fee on the way. Null means the full amount
  /// arrives: the Evabob fee is always added on top, never taken from it.
  final double? landedAmount;

  /// Heading for the landed line: "They receive", "Arrives on Base".
  final String landedLabel;

  /// The payee's profile photo, so a person can recognise who they are
  /// paying, not just read a name.
  final String? payeePhotoUrl;

  /// What lands at the other end, stated before the PIN.
  double get landed => landedAmount ?? amount;

  /// Cautions from the server's payee check — a lookalike address, an address
  /// that is not an Evabob account. Shown above everything else on the sheet.
  final List<String> cautions;

  /// When set, the sheet offers to send in this many minutes instead of now,
  /// so the sender can still cancel if the call they are on is a scam.
  final int? coolingOffMinutes;

  /// Whether that offer starts switched on: a first payment to someone new.
  final bool coolingOffDefault;

  /// How the Evabob fee is taken. True: added on top, so the total is shown.
  /// False (a conversion): taken inside the rate, so only the fee is shown.
  final bool feeOnTop;

  final int tokenDecimals;

  /// True of a straight payment: it lands and there is no way back.
  static const irreversible =
      'Once you confirm, this cannot be undone. There is no way to cancel it '
      'or get it back.';

  /// True of a hold: the balance goes down now, but the money is still yours
  /// until you hand it over.
  static const heldFirst =
      'The money leaves your balance now. It only reaches them when you '
      'release it, and comes back to you if you never do.';

  /// Who gets the money, named the way a person would name them: a saved
  /// contact, an @handle, an email address. A raw address only when nothing
  /// better is known.
  final String payee;

  /// The address behind the name, for checking against. Null when [payee] is
  /// already exactly what the user typed — repeating it there adds nothing to
  /// check.
  final String? payeeDetail;

  final double amount;
  final String token;

  /// Verb for the button: Send, Convert, Move.
  final String action;

  /// Whether this payee is new. A mistyped address that has never been paid
  /// before is the one mistake with no recovery, so it earns a deliberate
  /// acknowledgement rather than a single tap.
  final bool firstTime;

  /// One extra line about what happens next, when there is something true and
  /// useful to say.
  final String? note;

  /// What the person is committing to. Defaults to [irreversible]; a hold
  /// passes [heldFirst] instead, because telling someone a refundable hold can
  /// never be undone is both false and the kind of false that stops people
  /// using the feature.
  final String warning;

  /// Heading above [payee]. Not every money move goes to a person: converting
  /// currency and moving between networks both end up somewhere rather than
  /// with someone, and "To: Euros" reads wrong.
  final String payeeLabel;

  /// A currency conversion. The rate is the thing that can still change, so it
  /// gets said instead of pretending the amount is fixed.
  static const rateMayMove =
      'Once you confirm, this cannot be undone. The rate can move a little '
      'before it settles.';
}

/// Shows the review sheet. Returns true only if the person confirmed.
Future<bool> confirmPayment(BuildContext context, PaymentReview review) async {
  final choice = await confirmPaymentChoice(context, review);
  return choice != null;
}

/// What the person chose on the review sheet.
class PaymentChoice {
  const PaymentChoice({required this.coolingOff});

  /// Send after the cooling-off window instead of now.
  final bool coolingOff;
}

/// Shows the review sheet. Null when cancelled; otherwise how to send.
Future<PaymentChoice?> confirmPaymentChoice(
  BuildContext context,
  PaymentReview review,
) {
  return showModalBottomSheet<PaymentChoice>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (ctx) => _ConfirmPaymentSheet(review: review),
  );
}

class _ConfirmPaymentSheet extends StatefulWidget {
  const _ConfirmPaymentSheet({required this.review});

  final PaymentReview review;

  @override
  State<_ConfirmPaymentSheet> createState() => _ConfirmPaymentSheetState();
}

class _ConfirmPaymentSheetState extends State<_ConfirmPaymentSheet> {
  bool _checked = false;
  late bool _coolingOff = widget.review.coolingOffMinutes != null &&
      widget.review.coolingOffDefault;

  @override
  Widget build(BuildContext context) {
    final r = widget.review;
    final minutes = r.coolingOffMinutes;
    // A payee never paid before has to tick the box. Everyone else is one tap.
    final canConfirm = !r.firstTime || _checked;

    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        child: Container(
          margin: const EdgeInsets.all(Space.md),
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.lg),
            boxShadow: Shadows.raised,
          ),
          padding:
              const EdgeInsets.fromLTRB(Space.lg, Space.lg, Space.lg, Space.md),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Check this before you pay',
                style: Type.title.copyWith(color: EvabobColors.nearBlack),
              ),
              const SizedBox(height: Space.lg),

              for (final caution in r.cautions) ...[
                _Caution(text: caution),
                const SizedBox(height: Space.md),
              ],

              // Who, first and largest. It is the thing most likely to be
              // wrong and the thing people actually recognise.
              Row(
                children: [
                  if (r.payeePhotoUrl != null &&
                      r.payeePhotoUrl!.isNotEmpty) ...[
                    CircleAvatar(
                      radius: 24,
                      backgroundColor: EvabobColors.sand,
                      foregroundImage: NetworkImage(r.payeePhotoUrl!),
                    ),
                    const SizedBox(width: Space.md),
                  ],
                  Expanded(
                    child: _Field(
                      label: r.payeeLabel,
                      value: r.payee,
                      style:
                          Type.title.copyWith(color: EvabobColors.nearBlack),
                    ),
                  ),
                ],
              ),
              if (r.payeeDetail != null && r.payeeDetail!.isNotEmpty) ...[
                const SizedBox(height: Space.sm),
                _VerifyChip(text: r.payeeDetail!),
              ],

              const SizedBox(height: Space.lg),
              _Field(
                label: 'Amount',
                value: formatMoney(r.amount, r.token),
                style: Type.hero.copyWith(
                  fontSize: 48,
                  color: EvabobColors.nearBlack,
                ),
              ),

              _FeeLines(review: r),

              const SizedBox(height: Space.lg),
              _Consequence(
                text: _coolingOff && minutes != null
                    ? 'It goes to them in $minutes minutes. Until then you can '
                        'cancel it from Activity and get it all back. After '
                        'that it cannot be undone.'
                    : r.warning,
              ),
              if (minutes != null) ...[
                const SizedBox(height: Space.sm),
                // Its own Material, so the tap ripple is not hidden under the
                // sheet's background.
                Material(
                  type: MaterialType.transparency,
                  child: SwitchListTile(
                    value: _coolingOff,
                    onChanged: (v) => setState(() => _coolingOff = v),
                    contentPadding: EdgeInsets.zero,
                    activeThumbColor: EvabobColors.emerald,
                    title: Text(
                      'Wait $minutes minutes before it goes',
                      style: Type.body.copyWith(color: EvabobColors.nearBlack),
                    ),
                    subtitle: Text(
                      'Time to hang up and check. If someone is rushing you to '
                      'pay, that is a reason to wait.',
                      style:
                          Type.caption.copyWith(color: EvabobColors.navyMuted),
                    ),
                  ),
                ),
              ],

              if (r.note != null && r.note!.isNotEmpty) ...[
                const SizedBox(height: Space.sm),
                Text(
                  r.note!,
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
              ],

              if (r.firstTime) ...[
                const SizedBox(height: Space.sm),
                _FirstTimeCheck(
                  value: _checked,
                  onChanged: (v) => setState(() => _checked = v),
                ),
              ],

              const SizedBox(height: Space.lg),
              Row(
                children: [
                  Expanded(
                    child: SizedBox(
                      height: 52,
                      child: TextButton(
                        onPressed: () => Navigator.pop(context),
                        child: Text(
                          'Cancel',
                          style: Type.label
                              .copyWith(color: EvabobColors.navyMuted),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: Space.md),
                  Expanded(
                    flex: 2,
                    child: SizedBox(
                      height: 52,
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                          backgroundColor: EvabobColors.emerald,
                          disabledBackgroundColor: EvabobColors.sand,
                          shape: RoundedRectangleBorder(
                            borderRadius: Radii.all(Radii.pill),
                          ),
                        ),
                        onPressed: canConfirm
                            ? () => Navigator.pop(
                                  context,
                                  PaymentChoice(coolingOff: _coolingOff),
                                )
                            : null,
                        child: Text(
                          _coolingOff && minutes != null
                              ? 'Send in $minutes min'
                              : '${r.action} ${formatMoney(r.amount, r.token)}',
                          style: Type.label.copyWith(
                            color: canConfirm
                                ? EvabobColors.onPrimary
                                : EvabobColors.navyMuted,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The Evabob fee, said before the PIN — never discovered afterwards on a
/// balance that dropped by more than the amount typed.
class _FeeLines extends StatelessWidget {
  const _FeeLines({required this.review});

  final PaymentReview review;

  @override
  Widget build(BuildContext context) {
    final features = context.watch<AppFeatures>();
    final feeFrom = review.feeFrom;
    final fee = features.platformFeeFor(
      feeFrom == null ? review.amount : review.landed,
      decimals: review.tokenDecimals,
    );
    // Only money going somewhere has a landed amount; a conversion's is the
    // rate, which the conversion screen already shows.
    final showLanded = review.feeOnTop || feeFrom != null;
    final landed = feeFrom == null ? review.landed : review.landed - fee;
    final percent = (features.platformFeeBps / 100)
        .toStringAsFixed(2)
        .replaceFirst(RegExp(r'0+$'), '')
        .replaceFirst(RegExp(r'\.$'), '');

    Widget line(String label, String value, {bool strong = false}) {
      return Padding(
        padding: const EdgeInsets.only(top: Space.sm),
        child: Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: Type.caption.copyWith(color: EvabobColors.navyMuted),
              ),
            ),
            Text(
              value,
              style: (strong ? Type.body : Type.caption)
                  .copyWith(color: EvabobColors.nearBlack),
            ),
          ],
        ),
      );
    }

    if (fee <= 0 && !showLanded) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: Space.sm),
      child: Column(
        children: [
          if (fee > 0)
            line(
              feeFrom != null
                  ? 'Evabob fee ($percent%, from $feeFrom)'
                  : review.feeOnTop
                      ? 'Evabob fee ($percent%)'
                      : 'Evabob fee ($percent%, taken from the conversion)',
              formatMoney(fee, review.token),
            ),
          if (review.feeOnTop && feeFrom == null && fee > 0)
            line(
              'You pay in total',
              formatMoney(review.amount + fee, review.token),
              strong: true,
            ),
          if (showLanded)
            line(
              review.landedAmount == null && feeFrom == null
                  ? review.landedLabel
                  : '${review.landedLabel} about',
              // Rounded down, so the figure shown is never more than lands.
              formatMoney(
                review.landedAmount == null && feeFrom == null
                    ? landed
                    : (landed * 100 + 1e-6).floorToDouble() / 100,
                review.token,
              ),
              strong: true,
            ),
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    required this.label,
    required this.value,
    required this.style,
  });

  final String label;
  final String value;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    // Merged so a screen reader says "To, Sarah" as one thing rather than
    // reading the label and the value as two unrelated stops.
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: Type.caption.copyWith(color: EvabobColors.navyMuted),
          ),
          const SizedBox(height: Space.xs),
          Text(value, style: style),
        ],
      ),
    );
  }
}

/// The address, shown only to be checked against — never as the answer to who
/// is being paid.
class _VerifyChip extends StatelessWidget {
  const _VerifyChip({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding:
          const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.sm),
      decoration: BoxDecoration(
        color: EvabobColors.pageBg,
        borderRadius: Radii.all(Radii.sm),
      ),
      child: Text(
        text,
        style: Type.micro.copyWith(
          fontFamily: 'monospace',
          color: EvabobColors.navyMuted,
        ),
      ),
    );
  }
}

/// A specific reason to stop and look, from the payee check. Stronger than the
/// general consequence line because it is about this payment in particular.
class _Caution extends StatelessWidget {
  const _Caution({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Space.md),
      decoration: BoxDecoration(
        color: EvabobColors.alert.withValues(alpha: 0.08),
        borderRadius: Radii.all(Radii.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.warning_amber_rounded,
            size: 18,
            color: EvabobColors.alert,
          ),
          const SizedBox(width: Space.sm),
          Expanded(
            child: Text(
              text,
              style: Type.caption.copyWith(color: EvabobColors.nearBlack),
            ),
          ),
        ],
      ),
    );
  }
}

class _Consequence extends StatelessWidget {
  const _Consequence({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(Space.md),
      decoration: BoxDecoration(
        color: EvabobColors.pageBg,
        borderRadius: Radii.all(Radii.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.info_outline_rounded,
            size: 18,
            color: EvabobColors.navyMuted,
          ),
          const SizedBox(width: Space.sm),
          Expanded(
            child: Text(
              text,
              style: Type.caption.copyWith(color: EvabobColors.navyMuted),
            ),
          ),
        ],
      ),
    );
  }
}

class _FirstTimeCheck extends StatelessWidget {
  const _FirstTimeCheck({required this.value, required this.onChanged});

  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => onChanged(!value),
      borderRadius: Radii.all(Radii.sm),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: Space.xs),
        child: Row(
          children: [
            // 44dp of touchable width, not the 24dp box Checkbox draws.
            SizedBox(
              width: 44,
              height: 44,
              child: Checkbox(
                value: value,
                onChanged: (v) => onChanged(v ?? false),
                activeColor: EvabobColors.emerald,
              ),
            ),
            Expanded(
              child: Text(
                'I have checked this is the right person.',
                style: Type.body.copyWith(color: EvabobColors.nearBlack),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
