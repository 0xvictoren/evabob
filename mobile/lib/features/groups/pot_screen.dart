import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/activity/activity_service.dart';
import '../../core/api/api_client.dart';
import '../../core/groups/groups_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// One collection: how far it has got, chipping in, and sharing it.
class PotScreen extends StatefulWidget {
  const PotScreen({super.key, required this.potId});

  final String potId;

  @override
  State<PotScreen> createState() => _PotScreenState();
}

class _PotScreenState extends State<PotScreen> {
  late final GroupsApi _api = GroupsApi(context.read<ApiClient>());
  final _amount = TextEditingController();
  GroupPot? _pot;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final g = await _api.get(widget.potId);
      if (!mounted) return;
      setState(() {
        _pot = g is PotGroup ? g.pot : null;
        _error = g is PotGroup ? null : 'That is not a collection.';
      });
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  Future<void> _chipIn(GroupPot p) async {
    final amount = double.tryParse(_amount.text.trim());
    if (amount == null || amount <= 0) return;
    final ok = await confirmPayment(
      context,
      PaymentReview(
        payeeLabel: 'Chipping in to',
        payee: p.title,
        amount: amount,
        action: 'Chip in',
        landedLabel: 'For ${p.beneficiary}',
        feeFrom: 'the collection when it is paid out',
        warning: 'It goes to ${p.beneficiary} only if the collection reaches '
            '${formatMoney(p.targetUsdc)} by '
            '${DateFormat('d MMM').format(p.deadline.toLocal())}. If it does '
            'not, you get it all back automatically.',
      ),
    );
    if (!ok || !mounted) return;
    setState(() => _busy = true);
    try {
      final circle = context.read<CircleWalletService>();
      final res = await circle.contributeToPot(
        context: context,
        potId: p.id,
        amountUsdc: amount,
      );
      if (!mounted) return;
      if (res['ok'] != true) {
        showTopSnack(
            context,
            SnackBar(
              content: Text(friendlyError(res['error'],
                  fallback: 'Your money was not added.')),
              behavior: SnackBarBehavior.floating,
            ));
      } else {
        _amount.clear();
        await context
            .read<WalletService>()
            .refreshBalances(addressOverride: circle.address);
        if (mounted) await context.read<ActivityService>().refresh();
      }
      await _load();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _share(GroupPot p) async {
    final box = context.findRenderObject() as RenderBox?;
    await SharePlus.instance.share(ShareParams(
      text: '${p.title}: ${formatMoney(p.raisedUsdc)} of '
          '${formatMoney(p.targetUsdc)} so far. Chip in — if we don\'t reach '
          'it, everyone is refunded automatically.\n${p.url}',
      sharePositionOrigin:
          box != null ? box.localToGlobal(Offset.zero) & box.size : null,
    ));
  }

  void _qr(GroupPot p) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(p.title),
        content: SizedBox(
          width: 220,
          height: 220,
          child: QrImageView(data: p.url, backgroundColor: Colors.white),
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: p.url));
              Navigator.pop(ctx);
            },
            child: const Text('Copy link'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = _pot;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Collection',
                onBack: () => Navigator.of(context).maybePop(),
                trailing: p == null
                    ? null
                    : IconButton(
                        tooltip: 'Share',
                        onPressed: () => _share(p),
                        icon: const Icon(Icons.ios_share_rounded),
                      ),
              ),
            ),
            Expanded(
              child: p == null
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
                        children: _body(p),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(GroupPot p) {
    final df = DateFormat('EEE d MMM, HH:mm');
    final left = p.deadline.difference(DateTime.now());
    final status = switch (p.state) {
      'released' => 'Reached — paid to ${p.beneficiary}',
      'refunding' => 'Called off — everyone is refunded',
      _ when !p.open => 'Did not reach its target — everyone is refunded',
      _ => left.inDays >= 1
          ? '${left.inDays} days left'
          : '${left.inHours.clamp(0, 24)} hours left',
    };
    return [
      Glass(
        heavy: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(p.title,
                style: Type.title.copyWith(color: EvabobColors.nearBlack)),
            if (p.description.isNotEmpty)
              Text(p.description,
                  style: Type.body.copyWith(color: EvabobColors.navyMuted)),
            const SizedBox(height: Space.md),
            Text(formatMoney(p.raisedUsdc),
                style: Type.hero
                    .copyWith(fontSize: 40, color: EvabobColors.nearBlack)),
            Text('of ${formatMoney(p.targetUsdc)} for ${p.beneficiary}',
                style: Type.body.copyWith(color: EvabobColors.navyMuted)),
            const SizedBox(height: Space.md),
            LinearProgressIndicator(
              value: p.progress,
              minHeight: 10,
              borderRadius: BorderRadius.circular(99),
              backgroundColor: EvabobColors.sand,
            ),
            const SizedBox(height: Space.sm),
            Text(
              '${(p.progress * 100).round()}% · ${p.contributors} '
              '${p.contributors == 1 ? 'person' : 'people'} · $status',
              style: Type.caption.copyWith(color: EvabobColors.navyMuted),
            ),
            Text('Deadline ${df.format(p.deadline.toLocal())}',
                style: Type.caption.copyWith(color: EvabobColors.navyMuted)),
            if (p.myContributionUsdc > 0)
              Text('You put in ${formatMoney(p.myContributionUsdc)}',
                  style:
                      Type.caption.copyWith(color: EvabobColors.emeraldDeep)),
          ],
        ),
      ),
      if (p.open) ...[
        const SizedBox(height: Space.md),
        Glass(
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _amount,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
                  ],
                  decoration: const InputDecoration(
                    prefixText: r'$ ',
                    hintText: 'Amount',
                    border: InputBorder.none,
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ),
              FilledButton(
                onPressed:
                    _busy || (double.tryParse(_amount.text.trim()) ?? 0) <= 0
                        ? null
                        : () => _chipIn(p),
                child: _busy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Chip in'),
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.md),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: () => _qr(p),
                icon: const Icon(Icons.qr_code_2_rounded),
                label: const Text('QR code'),
              ),
            ),
            const SizedBox(width: Space.md),
            Expanded(
              child: FilledButton.icon(
                onPressed: () => _share(p),
                icon: const Icon(Icons.ios_share_rounded),
                label: const Text('Share link'),
              ),
            ),
          ],
        ),
      ],
      const SizedBox(height: Space.lg),
      Text(
        'Nobody holds this money. It goes to ${p.beneficiary} the moment the '
        'target is reached. If the deadline passes first, everyone gets back '
        'exactly what they put in, automatically. Anyone with the link can '
        'see the progress.',
        style: Type.caption.copyWith(color: EvabobColors.navyMuted),
      ),
    ];
  }
}
