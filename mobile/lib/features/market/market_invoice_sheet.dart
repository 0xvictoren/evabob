import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/fx/fx_service.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/amount_input.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';

/// The seller's invoice to a buyer who messaged them: priced lines, when it
/// will be done, and a note. It is sent into their chat as a request the
/// buyer pays there — all held until delivered, half held, or all now.
///
/// Pops with true once it is sent.
class MarketInvoiceSheet extends StatefulWidget {
  const MarketInvoiceSheet({
    super.key,
    required this.api,
    required this.contactId,
    required this.title,
    required this.suggestedUsd,
    required this.deliveryDays,
    this.buyerBudget = false,
  });

  final MarketApi api;
  final String contactId;

  /// What the post is about; the first line starts as this.
  final String title;

  /// The post's price: the listed price, or the most the buyer will pay.
  final double suggestedUsd;
  final int deliveryDays;

  /// True when [suggestedUsd] is a buyer's budget, not a listed price.
  final bool buyerBudget;

  static Future<bool> show(
    BuildContext context, {
    required MarketApi api,
    required String contactId,
    required String title,
    required double suggestedUsd,
    required int deliveryDays,
    bool buyerBudget = false,
  }) async {
    final sent = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => MarketInvoiceSheet(
        api: api,
        contactId: contactId,
        title: title,
        suggestedUsd: suggestedUsd,
        deliveryDays: deliveryDays,
        buyerBudget: buyerBudget,
      ),
    );
    return sent == true;
  }

  @override
  State<MarketInvoiceSheet> createState() => _MarketInvoiceSheetState();
}

class _Line {
  _Line(String what, String amount)
      : what = TextEditingController(text: what),
        amount = TextEditingController(text: amount);

  final TextEditingController what;
  final TextEditingController amount;

  void dispose() {
    what.dispose();
    amount.dispose();
  }
}

class _MarketInvoiceSheetState extends State<MarketInvoiceSheet> {
  static const _maxLines = 10;

  final List<_Line> _lines = [];
  final _note = TextEditingController();
  late int _days = widget.deliveryDays;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final fx = context.read<FxService>();
    _lines.add(_Line(
      widget.title,
      fx.fromUsd(widget.suggestedUsd).toStringAsFixed(fx.inputDecimals),
    ));
  }

  @override
  void dispose() {
    for (final l in _lines) {
      l.dispose();
    }
    _note.dispose();
    super.dispose();
  }

  double _typed(_Line l) =>
      double.tryParse(l.amount.text.replaceAll(',', '')) ?? 0;

  double get _total => _lines.fold(0, (sum, l) => sum + _typed(l));

  Future<void> _send() async {
    final fx = context.read<FxService>();
    final items = <Map<String, dynamic>>[];
    for (final l in _lines) {
      final what = l.what.text.trim();
      final amount = _typed(l);
      if (what.isEmpty && amount <= 0) continue;
      if (what.isEmpty || amount <= 0) {
        setState(() => _error = 'Each line needs what it is and its price.');
        return;
      }
      items.add({'description': what, 'amount': fx.toUsd(amount)});
    }
    if (items.isEmpty) {
      setState(() => _error = 'Add at least one priced line.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.sendInvoice(
        widget.contactId,
        items: items,
        note: _note.text.trim(),
        deliveryDays: _days,
        display: {'currency': fx.dominant.code, 'amount': _total},
      );
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = friendlyError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: Container(
        margin: const EdgeInsets.all(Space.md),
        padding: const EdgeInsets.all(Space.page),
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.86,
        ),
        decoration: BoxDecoration(
          color: EvabobColors.sheet,
          borderRadius: Radii.all(Radii.lg),
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Send an invoice', style: Type.title),
              const SizedBox(height: 4),
              Text(
                widget.buyerBudget
                    ? 'They will pay up to ${fx.primary(widget.suggestedUsd)}. '
                        'List what you will do and what each part costs.'
                    : 'List what they are paying for. It goes into your chat '
                        'for them to pay.',
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
              const SizedBox(height: Space.md),
              for (var i = 0; i < _lines.length; i++)
                Padding(
                  padding: const EdgeInsets.only(bottom: Space.sm),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 5,
                        child: TextField(
                          controller: _lines[i].what,
                          maxLength: 200,
                          textCapitalization: TextCapitalization.sentences,
                          decoration: const InputDecoration(
                            hintText: 'What it is',
                            counterText: '',
                          ),
                        ),
                      ),
                      const SizedBox(width: Space.sm),
                      Expanded(
                        flex: 4,
                        child: TextField(
                          controller: _lines[i].amount,
                          onChanged: (_) => setState(() {}),
                          keyboardType: const TextInputType.numberWithOptions(
                              decimal: true),
                          inputFormatters: const [AmountInputFormatter()],
                          decoration: InputDecoration(
                            hintText: '0',
                            prefixText: '${fx.dominant.symbol} ',
                          ),
                        ),
                      ),
                      if (_lines.length > 1)
                        IconButton(
                          tooltip: 'Remove this line',
                          onPressed: () => setState(() {
                            _lines.removeAt(i).dispose();
                          }),
                          icon: const Icon(Icons.close_rounded, size: 20),
                        ),
                    ],
                  ),
                ),
              if (_lines.length < _maxLines)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () =>
                        setState(() => _lines.add(_Line('', ''))),
                    icon: const Icon(Icons.add_rounded, size: 18),
                    label: const Text('Add a line'),
                  ),
                ),
              Row(
                children: [
                  Expanded(
                    child: Text('Done within',
                        style: Type.body.copyWith(color: EvabobColors.ink)),
                  ),
                  IconButton(
                    onPressed:
                        _days > 1 ? () => setState(() => _days--) : null,
                    icon: const Icon(Icons.remove_circle_outline),
                  ),
                  Text('$_days ${_days == 1 ? 'day' : 'days'}',
                      style: Type.body),
                  IconButton(
                    onPressed:
                        _days < 60 ? () => setState(() => _days++) : null,
                    icon: const Icon(Icons.add_circle_outline),
                  ),
                ],
              ),
              TextField(
                controller: _note,
                maxLines: 2,
                maxLength: 600,
                decoration: const InputDecoration(
                  hintText: 'Anything they should know (optional)',
                ),
              ),
              Row(
                children: [
                  Expanded(
                    child: Text('Total',
                        style: Type.body.copyWith(color: EvabobColors.ink)),
                  ),
                  Text(
                    fx.isDollar ? fx.primary(_total) : fx.format(_total),
                    style: Type.title.copyWith(color: EvabobColors.ink),
                  ),
                ],
              ),
              if (!fx.isDollar && _total > 0)
                Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    '≈ ${fx.secondary(fx.toUsd(_total))}',
                    style: Type.label.copyWith(color: EvabobColors.inkMuted),
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
                label: 'Send invoice',
                busy: _busy,
                onPressed: _send,
              ),
              const SizedBox(height: Space.sm),
              Text(
                'They choose how to pay: all set aside until you deliver, '
                'half now and half set aside, or all now.',
                style: Type.label.copyWith(color: EvabobColors.inkMuted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
