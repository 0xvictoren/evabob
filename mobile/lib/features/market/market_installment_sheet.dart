import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/fx/fx_service.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/amount_input.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/evabob_ui.dart';

/// Paying for something in parts.
///
/// Each part is set aside in a hold for the seller: it leaves the buyer's
/// balance but does not reach the seller. When the parts add up to the
/// price, the deal goes ahead like any deal whose money is set aside. If
/// they do not add up by the deadline, every part comes back to the buyer.
///
/// Pops with true when a part was paid.
class MarketInstallmentSheet extends StatefulWidget {
  const MarketInstallmentSheet({
    super.key,
    required this.api,
    required this.deal,
    required this.recipient,
  });

  final MarketApi api;
  final MarketDeal deal;

  /// The seller's @handle: who each part is held for.
  final String recipient;

  static Future<bool> show(
    BuildContext context, {
    required MarketApi api,
    required MarketDeal deal,
    required String recipient,
  }) async =>
      await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => MarketInstallmentSheet(
            api: api, deal: deal, recipient: recipient),
      ) ==
      true;

  @override
  State<MarketInstallmentSheet> createState() => _MarketInstallmentSheetState();
}

class _MarketInstallmentSheetState extends State<MarketInstallmentSheet> {
  final _amount = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final fx = context.read<FxService>();
    _amount.text = fx
        .fromUsd(widget.deal.installmentLeftUsd)
        .toStringAsFixed(fx.inputDecimals);
  }

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _pay() async {
    final fx = context.read<FxService>();
    final typed = double.tryParse(_amount.text.replaceAll(',', ''));
    if (typed == null || typed <= 0) {
      setState(() => _error = 'Enter how much to pay now.');
      return;
    }
    final left = widget.deal.installmentLeftUsd;
    // Typed in the person's own currency, so allow a hair over for rounding
    // and never set aside more than is owed.
    var usd = fx.toUsd(typed);
    if (usd > left + 0.01) {
      setState(() => _error =
          'Only ${fx.primary(left)} is left to pay. Enter that or less.');
      return;
    }
    if (usd > left) usd = left;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final title = widget.deal.title;
      final held = await context.read<CircleWalletService>().holdForRecipient(
            context: context,
            recipient: widget.recipient,
            amountUsdc: usd,
            purpose: 'job',
            memo: title.length <= 100 ? 'Part payment: $title' : 'Part payment',
            paymentRequestId: widget.deal.requestId,
          );
      if (!mounted) return;
      final transferId = held['transferId']?.toString();
      if (held['ok'] != true || transferId == null || transferId.isEmpty) {
        throw Exception(held['pending'] == true
            ? 'Your PIN went through and the money is being set aside. Check Activity in a minute, and do not pay this part again.'
            : held['error']?.toString() ?? 'That part was not set aside');
      }
      await widget.api.addInstallmentPart(widget.deal.id, transferId);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = friendlyError(e, fallback: 'That part was not set aside.');
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    final deal = widget.deal;
    final due = deal.installmentDueAt?.toLocal();
    final progress =
        deal.priceUsd <= 0 ? 0.0 : deal.installmentPaidUsd / deal.priceUsd;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Container(
        margin: const EdgeInsets.all(Space.md),
        padding: const EdgeInsets.all(Space.page),
        decoration: BoxDecoration(
          color: EvabobColors.sheet,
          borderRadius: Radii.all(Radii.lg),
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Pay in parts', style: Type.title),
              const SizedBox(height: 4),
              Text(
                deal.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
              const SizedBox(height: Space.md),
              ClipRRect(
                borderRadius: Radii.all(Radii.pill),
                child: LinearProgressIndicator(
                  value: progress.clamp(0, 1).toDouble(),
                  minHeight: 8,
                  backgroundColor: EvabobColors.pageBg,
                ),
              ),
              const SizedBox(height: Space.sm),
              Text(
                '${fx.primary(deal.installmentPaidUsd)} of '
                '${fx.primary(deal.priceUsd)} set aside · '
                '${fx.primary(deal.installmentLeftUsd)} to go',
                style: Type.body.copyWith(color: EvabobColors.ink),
              ),
              if (due != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    'Finish by ${DateFormat('EEE d MMM, HH:mm').format(due)}',
                    style: Type.label.copyWith(color: EvabobColors.inkMuted),
                  ),
                ),
              const SizedBox(height: Space.md),
              TextField(
                controller: _amount,
                keyboardType:
                    const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: const [AmountInputFormatter()],
                decoration: InputDecoration(
                  labelText: 'Pay now (${fx.dominant.plural})',
                  prefixText: '${fx.dominant.symbol} ',
                ),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: Space.sm),
                  child: Text(_error!,
                      style: Type.label.copyWith(color: EvabobColors.alert)),
                ),
              const SizedBox(height: Space.md),
              EvabobPrimaryButton(
                label: 'Set this part aside',
                busy: _busy,
                onPressed: _pay,
              ),
              const SizedBox(height: Space.sm),
              Text(
                'Each part leaves your balance and is held, not sent to the '
                'seller, who is told as it comes in. Pay the full amount by '
                'the deadline and the deal goes ahead. If you do not, '
                'everything you set aside comes back to you.',
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
