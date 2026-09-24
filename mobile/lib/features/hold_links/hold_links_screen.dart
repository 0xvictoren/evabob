import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api/api_client.dart';
import '../../core/held/hold_links_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import 'package:evabob_mobile/core/utils/amount_input.dart';
import 'package:evabob_mobile/core/fx/fx_service.dart';

/// For people who sell on WhatsApp and Instagram: one link per thing sold.
///
/// A buyer who opens it pays into a hold, not straight to the seller, so
/// paying a stranger stops being a leap of faith. The seller marks each order
/// delivered from their held payments; the buyer has 7 days to object, and
/// silence pays the seller.
class HoldLinksScreen extends StatefulWidget {
  const HoldLinksScreen({super.key});

  @override
  State<HoldLinksScreen> createState() => _HoldLinksScreenState();
}

class _HoldLinksScreenState extends State<HoldLinksScreen> {
  late final HoldLinksApi _api = HoldLinksApi(context.read<ApiClient>());
  List<HoldLink>? _items;
  SellerRecord _record = const SellerRecord();
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final (items, record) = await _api.mine();
      if (!mounted) return;
      setState(() {
        _items = items;
        _record = record;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  Future<void> _create() async {
    final link = await showModalBottomSheet<HoldLink>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _NewLinkSheet(api: _api),
    );
    if (link == null || !mounted) return;
    await _load();
    if (mounted) _showQr(link);
  }

  String _shareText(HoldLink l) => '${l.title} — ${formatMoney(l.amount)}.\n'
      'Pay safely: your money is set aside for me until your order arrives.\n'
      '${l.url}';

  Future<void> _share(HoldLink l) async {
    final box = context.findRenderObject() as RenderBox?;
    await SharePlus.instance.share(
      ShareParams(
        text: _shareText(l),
        sharePositionOrigin:
            box != null ? box.localToGlobal(Offset.zero) & box.size : null,
      ),
    );
  }

  Future<void> _copy(HoldLink l) async {
    await Clipboard.setData(ClipboardData(text: l.url));
    if (!mounted) return;
    showTopSnack(
      context,
      const SnackBar(
        content: Text('Link copied. Paste it in a chat, a post or your bio.'),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  void _showQr(HoldLink l) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.title),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 220,
              height: 220,
              child: QrImageView(
                data: l.url,
                backgroundColor: Colors.white,
                semanticsLabel: 'QR code for ${l.title}',
              ),
            ),
            const SizedBox(height: 10),
            Text(
              '${formatMoney(l.amount)} · buyers scan to pay safely',
              style: Type.caption.copyWith(color: EvabobColors.navyMuted),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Done'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.pop(ctx);
              _share(l);
            },
            child: const Text('Share'),
          ),
        ],
      ),
    );
  }

  Future<void> _setOpen(HoldLink l, bool open) async {
    try {
      await _api.setOpen(l.id, open);
      await _load();
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text(friendlyError(e)),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _create,
        icon: const Icon(Icons.add_link_rounded),
        label: const Text('New link'),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Sell with a link',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding:
                      const EdgeInsets.fromLTRB(Space.page, 0, Space.page, 96),
                  children: [
                    Text(
                      'Paste a link in WhatsApp, Instagram or your bio. A '
                      "buyer's money is set aside for you until their order "
                      'arrives, so paying someone they have never met stops '
                      'being a risk. Mark each order delivered from Activity '
                      'when you send it.',
                      style:
                          Type.caption.copyWith(color: EvabobColors.navyMuted),
                    ),
                    const SizedBox(height: Space.md),
                    Glass(
                      child: Row(
                        children: [
                          Icon(Icons.verified_outlined,
                              color: EvabobColors.emeraldDeep),
                          const SizedBox(width: Space.md),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('Your track record',
                                    style: Type.body.copyWith(
                                        color: EvabobColors.nearBlack)),
                                Text(
                                  _record.summary,
                                  style: Type.caption
                                      .copyWith(color: EvabobColors.navyMuted),
                                ),
                                if (_record.inProgress > 0)
                                  Text(
                                    '${_record.inProgress} in progress',
                                    style: Type.caption.copyWith(
                                        color: EvabobColors.navyMuted),
                                  ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: Space.md),
                    if (items == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 60),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (items != null && items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 40),
                        child: Text(
                          'No links yet. Make one for the next thing you sell.',
                          textAlign: TextAlign.center,
                          style:
                              Type.body.copyWith(color: EvabobColors.navyMuted),
                        ),
                      ),
                    for (final l in items ?? const <HoldLink>[])
                      Padding(
                        padding: const EdgeInsets.only(bottom: Space.sm),
                        child: Glass(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      l.title,
                                      style: Type.body.copyWith(
                                        color: l.active
                                            ? EvabobColors.nearBlack
                                            : EvabobColors.navyMuted,
                                      ),
                                    ),
                                  ),
                                  Text(formatMoney(l.amount),
                                      style: Type.body.copyWith(
                                          color: EvabobColors.nearBlack)),
                                ],
                              ),
                              const SizedBox(height: 2),
                              Text(
                                [
                                  'Deliver within ${l.deliveryDays} days',
                                  if (l.ordersTotal == 0)
                                    'no orders yet'
                                  else
                                    '${l.ordersTotal} orders · '
                                        '${l.ordersWaiting} waiting · '
                                        '${l.ordersPaid} paid',
                                  if (!l.active) 'closed',
                                ].join(' · '),
                                style: Type.caption
                                    .copyWith(color: EvabobColors.navyMuted),
                              ),
                              const SizedBox(height: Space.sm),
                              Row(
                                children: [
                                  if (l.active) ...[
                                    IconButton(
                                      tooltip: 'Show QR code',
                                      onPressed: () => _showQr(l),
                                      icon: const Icon(Icons.qr_code_2_rounded),
                                    ),
                                    IconButton(
                                      tooltip: 'Copy link',
                                      onPressed: () => _copy(l),
                                      icon: const Icon(Icons.link_rounded),
                                    ),
                                    IconButton(
                                      tooltip: 'Share',
                                      onPressed: () => _share(l),
                                      icon: const Icon(Icons.ios_share_rounded),
                                    ),
                                  ],
                                  const Spacer(),
                                  TextButton(
                                    onPressed: () => _setOpen(l, !l.active),
                                    child: Text(l.active ? 'Close' : 'Reopen'),
                                  ),
                                ],
                              ),
                            ],
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

class _NewLinkSheet extends StatefulWidget {
  const _NewLinkSheet({required this.api});

  final HoldLinksApi api;

  @override
  State<_NewLinkSheet> createState() => _NewLinkSheetState();
}

class _NewLinkSheetState extends State<_NewLinkSheet> {
  final _title = TextEditingController();
  final _price = TextEditingController();
  final _details = TextEditingController();
  int _days = 14;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    _price.dispose();
    _details.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final price = double.tryParse(_price.text.trim());
    if (_title.text.trim().isEmpty) {
      setState(() => _error = 'Say what you are selling.');
      return;
    }
    if (price == null || price <= 0) {
      setState(() => _error = 'Enter a price.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final link = await widget.api.create(
        title: _title.text.trim(),
        // Priced in the seller's own currency; buyers pay the dollar amount.
        amount: context.read<FxService>().toUsd(price),
        description: _details.text.trim(),
        deliveryDays: _days,
      );
      if (mounted) Navigator.pop(context, link);
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
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
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('New link',
                    style: Type.title.copyWith(color: EvabobColors.nearBlack)),
                const SizedBox(height: Space.md),
                TextField(
                  controller: _title,
                  maxLength: 80,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: const InputDecoration(
                    labelText: 'What are you selling?',
                    hintText: 'Ankara dress, size 12',
                    counterText: '',
                  ),
                ),
                const SizedBox(height: Space.sm),
                Builder(builder: (context) {
                  final fx = context.watch<FxService>();
                  final typed = double.tryParse(_price.text.trim()) ?? 0;
                  return TextField(
                    controller: _price,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [
                      const AmountInputFormatter(),
                    ],
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      labelText: 'Price',
                      prefixText: '${fx.dominant.symbol} ',
                      helperText: typed > 0
                          ? '≈ ${fx.secondary(fx.toUsd(typed))}'
                          : null,
                    ),
                  );
                }),
                const SizedBox(height: Space.sm),
                TextField(
                  controller: _details,
                  maxLength: 400,
                  maxLines: 3,
                  minLines: 1,
                  decoration: const InputDecoration(
                    labelText: 'Details (optional)',
                    hintText: 'Colour, size, where you ship from',
                    counterText: '',
                  ),
                ),
                const SizedBox(height: Space.md),
                Text('You will deliver within',
                    style: Type.label.copyWith(color: EvabobColors.nearBlack)),
                const SizedBox(height: Space.sm),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final d in const [3, 7, 14, 30])
                      ChoiceChip(
                        label: Text('$d days'),
                        selected: _days == d,
                        onSelected: (_) => setState(() => _days = d),
                      ),
                  ],
                ),
                const SizedBox(height: Space.sm),
                Text(
                  'If you have not marked an order delivered by then, the '
                  'buyer gets their money back.',
                  style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                ),
                if (_error != null) ...[
                  const SizedBox(height: Space.sm),
                  Text(_error!,
                      style: Type.caption.copyWith(color: EvabobColors.alert)),
                ],
                const SizedBox(height: Space.lg),
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: FilledButton(
                    onPressed: _busy ? null : _save,
                    child: _busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Make link'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
