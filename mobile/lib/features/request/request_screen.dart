import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/utils/handles.dart';
import '../../core/fx/fx_service.dart';
import '../../core/utils/money_format.dart';
import '../../core/api/api_client.dart';
import '../../core/utils/text_safe.dart';
import '../../core/auth/evabob_auth.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/asset_thumbnail.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';
import '../../core/widgets/receive_qr_sheet.dart';
import 'request_history_screen.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import 'package:evabob_mobile/core/utils/amount_input.dart';

/// Getting paid, two ways.
///
/// Most of the time someone just wants to hand over an address or a handle, so
/// that is the tab you land on. Building an itemised invoice is the rarer,
/// deliberate act, so it sits one tap away rather than being the first thing
/// you meet.
class RequestScreen extends StatefulWidget {
  const RequestScreen({super.key, this.onBack});

  final VoidCallback? onBack;

  @override
  State<RequestScreen> createState() => _RequestScreenState();
}

class _RequestScreenState extends State<RequestScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(gradient: EvabobColors.meshWarm),
      child: SafeArea(
        child: Column(
          children: [
            Padding(
              padding:
                  const EdgeInsets.fromLTRB(Space.xs, Space.xs, Space.page, 0),
              child: Row(
                children: [
                  if (widget.onBack != null)
                    IconButton(
                      onPressed: widget.onBack,
                      tooltip: 'Back',
                      icon: const Icon(Icons.chevron_left_rounded),
                    )
                  else
                    const SizedBox(width: Space.md),
                  Text(
                    'Get paid',
                    style: Type.title.copyWith(color: EvabobColors.nearBlack),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: Container(
                decoration: BoxDecoration(
                  color: EvabobColors.sheet,
                  borderRadius: Radii.all(Radii.pill),
                ),
                padding: const EdgeInsets.all(Space.xs),
                child: TabBar(
                  controller: _tabs,
                  dividerHeight: 0,
                  indicatorSize: TabBarIndicatorSize.tab,
                  indicator: BoxDecoration(
                    color: EvabobColors.mint,
                    borderRadius: Radii.all(Radii.pill),
                  ),
                  labelColor: EvabobColors.forest,
                  unselectedLabelColor: EvabobColors.navyMuted,
                  labelStyle: Type.label,
                  tabs: const [
                    Tab(text: 'Share details'),
                    Tab(text: 'Invoice'),
                  ],
                ),
              ),
            ),
            const SizedBox(height: Space.lg),
            Expanded(
              child: TabBarView(
                controller: _tabs,
                children: const [_ShareDetailsTab(), _InvoiceTab()],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Your wallet address, handle and email, each copyable on its own.
///
/// Three ways to be paid, and which one is right depends entirely on who is
/// asking — a handle for a friend already on Evabob, an address for anyone
/// else. So all three are offered rather than one being guessed at.
class _ShareDetailsTab extends StatelessWidget {
  const _ShareDetailsTab();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<EvabobAuth>();
    final circle = context.watch<CircleWalletService>();

    final handle = auth.user?.handle;
    final email = auth.user?.email;
    final address = circle.address ?? auth.user?.smartAccount;

    final rows = <(String, String, String?, IconData)>[
      (
        'Your handle',
        handle == null || handle.isEmpty ? 'Not set yet' : '@$handle',
        handle == null || handle.isEmpty ? null : '@$handle',
        Icons.alternate_email_rounded,
      ),
      (
        'Your email',
        email ?? 'Not set',
        email,
        Icons.mail_outline_rounded,
      ),
      (
        'Your wallet address',
        address == null || address.isEmpty
            ? 'Set up your wallet first'
            : address,
        address == null || address.isEmpty ? null : address,
        Icons.account_balance_wallet_outlined,
      ),
    ];

    return ListView(
      padding: const EdgeInsets.fromLTRB(Space.page, 0, Space.page, 100),
      children: [
        Text(
          'Give any one of these to whoever is paying you.',
          style: Type.body.copyWith(color: EvabobColors.navyMuted),
        ),
        const SizedBox(height: Space.lg),
        for (var i = 0; i < rows.length; i++)
          RiseIn(
            index: i,
            child: Padding(
              padding: const EdgeInsets.only(bottom: Space.sm),
              child: _CopyRow(
                label: rows[i].$1,
                value: rows[i].$2,
                copyable: rows[i].$3,
                icon: rows[i].$4,
                onQr: i == 2 && rows[i].$3 != null
                    ? () => showReceiveQr(
                          context,
                          address: rows[i].$3!,
                          network: 'Arc',
                          handle: handle,
                        )
                    : null,
              ),
            ),
          ),
      ],
    );
  }
}

class _CopyRow extends StatelessWidget {
  const _CopyRow({
    required this.label,
    required this.value,
    required this.copyable,
    required this.icon,
    this.onQr,
  });

  final String label;
  final String value;
  final String? copyable;
  final IconData icon;

  /// Shows the value as a QR code to scan (the wallet address row).
  final VoidCallback? onQr;

  @override
  Widget build(BuildContext context) {
    final enabled = copyable != null;
    return PressScale(
      scale: enabled ? Motion.pressScale : 1,
      onTap: enabled
          ? () async {
              await Clipboard.setData(ClipboardData(text: copyable!));
              if (!context.mounted) return;
              showTopSnack(
                context,
                SnackBar(
                  content: Text('$label copied'),
                  behavior: SnackBarBehavior.floating,
                ),
              );
            }
          : null,
      child: Container(
        decoration: BoxDecoration(
          color: EvabobColors.sheet,
          borderRadius: Radii.all(Radii.md),
          border: Border.all(color: EvabobColors.hairline),
          boxShadow: Shadows.subtle,
        ),
        padding: const EdgeInsets.all(Space.lg),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: const BoxDecoration(
                color: EvabobColors.mint,
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 18, color: EvabobColors.forest),
            ),
            const SizedBox(width: Space.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: Type.micro.copyWith(color: EvabobColors.navyMuted),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.label.copyWith(
                      color: enabled
                          ? EvabobColors.nearBlack
                          : EvabobColors.navyMuted,
                    ),
                  ),
                ],
              ),
            ),
            if (enabled) ...[
              const SizedBox(width: Space.sm),
              // These were an 18x18 icon and a bare GestureDetector around
              // another one — well under the 44dp anyone can reliably hit, and
              // unreachable by a screen reader.
              Row(
                children: [
                  const Icon(Icons.copy_rounded,
                      size: 18, color: EvabobColors.navyMuted),
                  if (onQr != null)
                    IconButton(
                      tooltip: 'Show QR code',
                      constraints:
                          const BoxConstraints(minWidth: 44, minHeight: 44),
                      onPressed: onQr,
                      icon: const Icon(Icons.qr_code_2_rounded,
                          size: 20, color: EvabobColors.navyMuted),
                    ),
                  IconButton(
                    tooltip: 'Share',
                    constraints:
                        const BoxConstraints(minWidth: 44, minHeight: 44),
                    onPressed: () => SharePlus.instance.share(
                      ShareParams(text: copyable!),
                    ),
                    icon: const Icon(Icons.ios_share_rounded,
                        size: 18, color: EvabobColors.navyMuted),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// One line of an invoice: what it is, and what it costs.
class _Line {
  _Line()
      : description = TextEditingController(),
        amount = TextEditingController();

  final TextEditingController description;
  final TextEditingController amount;

  double get value => double.tryParse(amount.text.trim()) ?? 0;

  void dispose() {
    description.dispose();
    amount.dispose();
  }
}

/// Build an invoice, one priced line at a time.
class _InvoiceTab extends StatefulWidget {
  const _InvoiceTab();

  @override
  State<_InvoiceTab> createState() => _InvoiceTabState();
}

class _InvoiceTabState extends State<_InvoiceTab> {
  final List<_Line> _lines = [_Line()];
  final _payer = TextEditingController();
  String _currency = 'USDC';
  bool _creating = false;

  /// When payment is due. The payer is reminded the day before, on the day,
  /// and three days late.
  DateTime? _dueAt;

  /// One hold per line, each paid out as that part is delivered.
  bool _milestones = false;

  int get _pricedLines => _lines.where((l) => l.value > 0).length;
  bool get _milestonesPossible =>
      _currency == 'USDC' && _pricedLines >= 2 && _pricedLines <= 10;

  @override
  void dispose() {
    for (final l in _lines) {
      l.dispose();
    }
    _payer.dispose();
    super.dispose();
  }

  Future<void> _pickDue() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _dueAt ?? now.add(const Duration(days: 7)),
      firstDate: now,
      lastDate: now.add(const Duration(days: 365)),
      helpText: 'Payment due',
    );
    if (picked == null || !mounted) return;
    // End of the chosen day, so "due today" means all of today.
    setState(
        () => _dueAt = DateTime(picked.year, picked.month, picked.day, 23, 59));
  }

  double get _total => _lines.fold(0, (sum, l) => sum + l.value);

  void _addLine() => setState(() => _lines.add(_Line()));

  void _removeLine(int i) {
    if (_lines.length == 1) return;
    setState(() => _lines.removeAt(i).dispose());
  }

  Future<void> _showSent(String link) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) => Container(
        padding: EdgeInsets.fromLTRB(
          Space.page,
          Space.sm,
          Space.page,
          Space.page + MediaQuery.paddingOf(sheetContext).bottom,
        ),
        decoration: const BoxDecoration(
          color: EvabobColors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(Radii.xl)),
          boxShadow: Shadows.sheet,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: EvabobColors.hairline,
                borderRadius: BorderRadius.circular(Radii.pill),
              ),
            ),
            const SizedBox(height: 40),
            const CircleAvatar(
              radius: 44,
              backgroundColor: EvabobColors.blueSoft,
              child: Icon(
                Icons.north_east_rounded,
                size: 36,
                color: EvabobColors.ink,
              ),
            ),
            const SizedBox(height: Space.xl),
            Text('Request sent', style: Type.title),
            const SizedBox(height: Space.sm),
            Text(
              'The payment link is copied. Share it with the person you asked, then follow its progress in request history.',
              textAlign: TextAlign.center,
              style: Type.body.copyWith(color: EvabobColors.inkMuted),
            ),
            const SizedBox(height: Space.xxl),
            SizedBox(
              width: double.infinity,
              height: 56,
              child: FilledButton.icon(
                onPressed: () => SharePlus.instance.share(
                  ShareParams(text: link, subject: 'Evabob request'),
                ),
                icon: const Icon(Icons.ios_share_rounded),
                label: const Text('Share request'),
              ),
            ),
            const SizedBox(height: Space.sm),
            TextButton(
              onPressed: () => Navigator.pop(sheetContext),
              child: const Text('Done'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _generate() async {
    if (_total <= 0 || _creating) return;
    setState(() => _creating = true);
    try {
      final api = context.read<ApiClient>();
      final fx = context.read<FxService>();
      final items = [
        for (final l in _lines)
          if (l.value > 0)
            {
              'description': l.description.text.trim(),
              // Typed in the person's own currency; the request is in
              // dollars underneath.
              'amount': _currency == 'USDC' ? fx.toUsd(l.value) : l.value,
            },
      ];
      // The caller is recorded as the one to be paid, so a link carries who
      // the money is for. Without that, whoever opens it has an amount and
      // nobody to send it to.
      // "ekuma", "@Ekuma" and "@ekuma" are the same person.
      final payer = normalizePayee(_payer.text);
      final data = await api.post('/v1/payment-requests', body: {
        'items': items,
        'token': _currency,
        'description': _lines.first.description.text.trim(),
        if (_dueAt != null) 'dueAt': _dueAt!.toUtc().toIso8601String(),
        if (payer.isNotEmpty) 'payer': payer,
        // What was typed, so it reads ₦2,500 — not a converted dollar
        // figure — for anyone who also thinks in naira.
        if (_currency == 'USDC')
          'display': {'currency': fx.dominant.code, 'amount': _total},
        if (_milestones && _milestonesPossible) 'milestones': true,
      });
      if (!mounted) return;

      final link = data['link']?.toString() ??
          data['shareUrl']?.toString() ??
          'evabob://pay/${data['id']}';
      await Clipboard.setData(ClipboardData(text: link));
      if (!mounted) return;

      setState(() {
        for (final l in _lines) {
          l.dispose();
        }
        _lines
          ..clear()
          ..add(_Line());
        _payer.clear();
        _dueAt = null;
        _milestones = false;
      });

      await _showSent(link);
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text(
              friendlyError(e, fallback: 'Could not create that invoice.')),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    final symbol = _currency == 'EURC' ? '€' : fx.dominant.symbol;
    return ListView(
      padding: const EdgeInsets.fromLTRB(Space.page, 0, Space.page, 120),
      children: [
        for (var i = 0; i < _lines.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: Space.sm),
            child: _LineRow(
              line: _lines[i],
              symbol: symbol,
              // The plus sits on the last row only, so it reads as "add
              // another" rather than as something you could do anywhere.
              onAdd: i == _lines.length - 1 ? _addLine : null,
              onRemove: _lines.length > 1 ? () => _removeLine(i) : null,
              onChanged: () => setState(() {}),
            ),
          ),
        const SizedBox(height: Space.md),
        Container(
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.md),
            boxShadow: Shadows.subtle,
          ),
          padding: const EdgeInsets.all(Space.lg),
          child: Row(
            children: [
              Text(
                'Currency',
                style: Type.label.copyWith(color: EvabobColors.nearBlack),
              ),
              const Spacer(),
              for (final c in const ['USDC', 'EURC'])
                Padding(
                  padding: const EdgeInsets.only(left: Space.sm),
                  child: PressScale(
                    scale: Motion.pressScale,
                    onTap: () => setState(() => _currency = c),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: Space.lg,
                        vertical: Space.sm,
                      ),
                      decoration: BoxDecoration(
                        color: _currency == c
                            ? EvabobColors.blue
                            : EvabobColors.creamDeep,
                        borderRadius: Radii.all(Radii.pill),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          AssetThumbnail(asset: c, size: 20),
                          const SizedBox(width: 6),
                          Text(
                            c == 'EURC'
                                ? 'Euros'
                                : (fx.isNaira ? 'Naira' : 'Dollars'),
                            style: Type.body.copyWith(
                              color: _currency == c
                                  ? EvabobColors.white
                                  : EvabobColors.navyMuted,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: Space.md),
        Container(
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.md),
            boxShadow: Shadows.subtle,
          ),
          padding:
              const EdgeInsets.fromLTRB(Space.lg, Space.sm, Space.lg, Space.sm),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: _payer,
                decoration: const InputDecoration(
                  labelText: 'Who pays? (optional)',
                  hintText: '@username or email',
                  border: InputBorder.none,
                ),
              ),
              const Divider(height: 1),
              Material(
                type: MaterialType.transparency,
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.event_outlined),
                  title: Text(
                    _dueAt == null
                        ? 'Add a due date'
                        : 'Due ${MaterialLocalizations.of(context).formatMediumDate(_dueAt!)}',
                    style: Type.body.copyWith(color: EvabobColors.nearBlack),
                  ),
                  subtitle: _dueAt == null
                      ? null
                      : Text(
                          _payer.text.trim().isEmpty
                              ? 'Add who pays and we will remind them.'
                              : 'We remind them the day before, on the day, '
                                  'and if it is late.',
                          style: Type.caption
                              .copyWith(color: EvabobColors.navyMuted),
                        ),
                  trailing: _dueAt == null
                      ? null
                      : IconButton(
                          tooltip: 'Remove the due date',
                          onPressed: () => setState(() => _dueAt = null),
                          icon: const Icon(Icons.close_rounded),
                        ),
                  onTap: _pickDue,
                ),
              ),
              const Divider(height: 1),
              Material(
                type: MaterialType.transparency,
                child: SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _milestones && _milestonesPossible,
                  onChanged: _milestonesPossible
                      ? (v) => setState(() => _milestones = v)
                      : null,
                  title: Text('Paid by milestone',
                      style: Type.body.copyWith(color: EvabobColors.nearBlack)),
                  subtitle: Text(
                    _milestonesPossible
                        ? 'Each line is set aside separately and paid to you '
                            'as you deliver it.'
                        : 'Add 2 to 10 lines in dollars, one per milestone.',
                    style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.md),
        Container(
          decoration: BoxDecoration(
            color: EvabobColors.mint,
            borderRadius: Radii.all(Radii.md),
          ),
          padding: const EdgeInsets.all(Space.lg),
          child: Row(
            children: [
              Text(
                'Total',
                style: Type.section.copyWith(color: EvabobColors.forest),
              ),
              const Spacer(),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    _currency == 'EURC'
                        ? formatEur(_total)
                        : (fx.isNaira ? formatNgn(_total) : formatUsd(_total)),
                    style: Type.title.copyWith(color: EvabobColors.nearBlack),
                  ),
                  if (_total > 0)
                    Text(
                      _currency == 'EURC'
                          ? '≈ ${fx.secondaryToken(_total, 'EURC')}'
                          : '≈ ${fx.secondary(fx.toUsd(_total))}',
                      style: Type.label.copyWith(color: EvabobColors.forest),
                    ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.lg),
        PressScale(
          scale: Motion.pressScale,
          onTap: _total > 0 && !_creating ? _generate : null,
          child: AnimatedOpacity(
            opacity: _total > 0 && !_creating ? 1 : 0.45,
            duration: Motion.fast,
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 18),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: EvabobColors.primary,
                borderRadius: Radii.all(Radii.md),
              ),
              child: Text(
                _creating ? 'Creating…' : 'Generate',
                style: Type.label.copyWith(
                  color: EvabobColors.onPrimary,
                  fontSize: 14,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: Space.md),
        Text(
          _milestones && _milestonesPossible
              ? 'Whoever opens the link pays you. They can pay it all now, or '
                  'set each milestone aside to be paid as you deliver it.'
              : 'Whoever opens the link pays you. They can pay it all now, or '
                  'hold some of it until you deliver.',
          style: Type.caption.copyWith(color: EvabobColors.navyMuted),
        ),
        const SizedBox(height: Space.lg),
        // Every request, both ways, lives on its own screen (Figma
        // "Request · history").
        Material(
          color: EvabobColors.white,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () => RequestHistoryScreen.open(context),
            child: Padding(
              padding: const EdgeInsets.all(Space.lg),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Your requests', style: Type.body),
                        const SizedBox(height: 2),
                        Text(
                          'What you asked for, and what was asked of you',
                          style: Type.label
                              .copyWith(color: EvabobColors.navyMuted),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right_rounded,
                      color: EvabobColors.navyMuted),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _LineRow extends StatelessWidget {
  const _LineRow({
    required this.line,
    required this.symbol,
    required this.onAdd,
    required this.onRemove,
    required this.onChanged,
  });

  final _Line line;
  final String symbol;
  final VoidCallback? onAdd;
  final VoidCallback? onRemove;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: EvabobColors.sheet,
        borderRadius: Radii.all(Radii.md),
        border: Border.all(color: EvabobColors.hairline),
        boxShadow: Shadows.subtle,
      ),
      padding: const EdgeInsets.symmetric(
        horizontal: Space.lg,
        vertical: Space.sm,
      ),
      child: Row(
        children: [
          Expanded(
            flex: 3,
            child: TextField(
              controller: line.description,
              style: Type.body.copyWith(color: EvabobColors.nearBlack),
              decoration: InputDecoration(
                hintText: 'What is it for?',
                hintStyle: Type.body.copyWith(color: EvabobColors.chalk),
                border: InputBorder.none,
              ),
            ),
          ),
          const SizedBox(width: Space.sm),
          SizedBox(
            width: 96,
            child: TextField(
              controller: line.amount,
              textAlign: TextAlign.right,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: const [AmountInputFormatter()],
              onChanged: (_) => onChanged(),
              style: Type.amount.copyWith(color: EvabobColors.nearBlack),
              decoration: InputDecoration(
                prefixText: symbol,
                prefixStyle:
                    Type.amount.copyWith(color: EvabobColors.navyMuted),
                hintText: '0.00',
                hintStyle: Type.amount.copyWith(color: EvabobColors.chalk),
                border: InputBorder.none,
              ),
            ),
          ),
          if (onRemove != null)
            IconButton(
              tooltip: 'Remove this line',
              onPressed: onRemove,
              icon: const Icon(Icons.close_rounded,
                  size: 18, color: EvabobColors.navyMuted),
            ),
          if (onAdd != null)
            IconButton(
              tooltip: 'Add another line',
              onPressed: onAdd,
              icon: const Icon(Icons.add_circle_outline_rounded,
                  size: 22, color: EvabobColors.forest),
            ),
        ],
      ),
    );
  }
}
