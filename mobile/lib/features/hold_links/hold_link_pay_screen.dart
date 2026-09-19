import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/api/api_client.dart';
import '../../core/held/hold_links_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/family_code_sheet.dart';
import '../../core/widgets/glass.dart';
import '../held/held_payment_screen.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// A buyer paying through a seller's link. Opened from `evabob://hold/{id}`.
///
/// The money goes into a hold for the seller, never straight to them.
class HoldLinkPayScreen extends StatefulWidget {
  const HoldLinkPayScreen({super.key, required this.linkId});

  final String linkId;

  @override
  State<HoldLinkPayScreen> createState() => _HoldLinkPayScreenState();
}

class _HoldLinkPayScreenState extends State<HoldLinkPayScreen> {
  PublicHoldLink? _link;
  String? _error;
  bool _paying = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final link =
          await HoldLinksApi(context.read<ApiClient>()).view(widget.linkId);
      if (mounted) setState(() => (_link = link, _error = null));
    } catch (e) {
      if (mounted) {
        setState(() => _error = friendlyError(
              e,
              fallback: 'This link could not be opened.',
            ));
      }
    }
  }

  Future<void> _pay(PublicHoldLink l) async {
    final name = l.sellerFirstName;
    final ok = await confirmPayment(
      context,
      PaymentReview(
        payee: l.sellerName,
        payeeDetail: l.sellerHandle,
        payeePhotoUrl: l.sellerAvatarUrl,
        amount: l.amount,
        action: 'Pay',
        landedLabel: 'Set aside for $name',
        warning: 'The money leaves your balance now but $name cannot spend '
            'it yet. $name is paid once your order arrives, or 7 days after '
            'it is marked delivered if you say nothing. If it is not '
            'delivered within ${l.deliveryDays} days, it comes back to you.',
        note: 'For: ${l.title}',
      ),
    );
    if (!ok || !mounted) return;
    if (!await passFamilyCheck(context, to: l.sellerHandle, amount: l.amount) ||
        !mounted) {
      return;
    }
    setState(() => _paying = true);
    try {
      final circle = context.read<CircleWalletService>();
      final res = await circle.holdForRecipient(
        context: context,
        recipient: l.sellerHandle,
        amountUsdc: l.amount,
        purpose: 'job',
        memo: shortUiText(l.title, max: 110),
        holdLinkId: l.id,
      );
      if (!mounted) return;
      if (res['ok'] != true) {
        showTopSnack(
          context,
          SnackBar(
            content: Text(friendlyError(
              res['error'],
              fallback: 'The payment did not go through.',
            )),
            behavior: SnackBarBehavior.floating,
          ),
        );
        return;
      }
      await context
          .read<WalletService>()
          .refreshBalances(addressOverride: circle.address);
      if (!mounted) return;
      await context.read<ActivityService>().refresh();
      final transferId = res['transferId']?.toString();
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text(
              'Paid. Your money is set aside for $name until your order arrives.'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      if (transferId != null && transferId.isNotEmpty) {
        await Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => HeldPaymentScreen(transferId: transferId),
          ),
        );
      } else {
        Navigator.of(context).maybePop();
      }
    } finally {
      if (mounted) setState(() => _paying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = _link;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Pay safely',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: l == null
                  ? Center(
                      child: _error == null
                          ? const CircularProgressIndicator()
                          : Padding(
                              padding: const EdgeInsets.all(Space.lg),
                              child: Text(_error!, textAlign: TextAlign.center),
                            ),
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(
                          Space.page, 0, Space.page, Space.xl),
                      children: [
                        Glass(
                          heavy: true,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  CircleAvatar(
                                    radius: 26,
                                    backgroundColor: EvabobColors.sand,
                                    foregroundImage: l.sellerAvatarUrl == null
                                        ? null
                                        : NetworkImage(l.sellerAvatarUrl!),
                                    child: Text(
                                      l.sellerFirstName
                                          .replaceFirst('@', '')
                                          .characters
                                          .first
                                          .toUpperCase(),
                                    ),
                                  ),
                                  const SizedBox(width: Space.md),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(l.sellerName,
                                            style: Type.body.copyWith(
                                                color: EvabobColors.nearBlack)),
                                        Text(
                                          [
                                            l.sellerHandle,
                                            if (l.sellerSince != null)
                                              'on Evabob since '
                                                  '${DateFormat('MMM yyyy').format(l.sellerSince!)}',
                                          ].join(' · '),
                                          style: Type.caption.copyWith(
                                              color: EvabobColors.navyMuted),
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                              const SizedBox(height: Space.sm),
                              Text(
                                l.record.summary,
                                style: Type.caption
                                    .copyWith(color: EvabobColors.navyMuted),
                              ),
                              const Divider(height: Space.xl),
                              Text(l.title,
                                  style: Type.title
                                      .copyWith(color: EvabobColors.nearBlack)),
                              if (l.description.isNotEmpty) ...[
                                const SizedBox(height: 4),
                                Text(l.description,
                                    style: Type.body.copyWith(
                                        color: EvabobColors.navyMuted)),
                              ],
                              const SizedBox(height: Space.md),
                              Text(
                                formatMoney(l.amount),
                                style: Type.hero.copyWith(
                                  fontSize: 44,
                                  color: EvabobColors.nearBlack,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: Space.md),
                        Glass(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Your money is set aside for '
                                '${l.sellerFirstName} until your order arrives.',
                                style: Type.body
                                    .copyWith(color: EvabobColors.nearBlack),
                              ),
                              const SizedBox(height: Space.sm),
                              for (final line in [
                                '${l.sellerFirstName} can see it is there but '
                                    'cannot spend it yet.',
                                '${l.sellerFirstName} sends your order within '
                                    '${l.deliveryDays} days and marks it '
                                    'delivered.',
                                'You then have 7 days to say it arrived, or '
                                    'tell us something is wrong. Say nothing '
                                    'and ${l.sellerFirstName} is paid.',
                                'Not delivered in time? The money comes back '
                                    'to you.',
                              ])
                                Padding(
                                  padding: const EdgeInsets.only(top: 4),
                                  child: Text('•  $line',
                                      style: Type.caption.copyWith(
                                          color: EvabobColors.navyMuted)),
                                ),
                            ],
                          ),
                        ),
                        const SizedBox(height: Space.lg),
                        SizedBox(
                          height: 54,
                          child: FilledButton(
                            onPressed:
                                !l.active || _paying ? null : () => _pay(l),
                            child: _paying
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                        strokeWidth: 2),
                                  )
                                : Text(l.active
                                    ? 'Pay ${formatMoney(l.amount)}'
                                    : 'No longer for sale'),
                          ),
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
