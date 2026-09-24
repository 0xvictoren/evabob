import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:provider/provider.dart';

import '../../core/utils/handles.dart';
import 'send_result_screen.dart';
import '../../core/activity/activity_service.dart';
import '../../core/api/api_client.dart';
import '../../core/calc/calculator.dart';
import '../../core/config/app_features.dart';
import '../../core/contacts/contacts_service.dart';
import '../../core/fx/fx_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_theme.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/payee_check.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/address_scan_sheet.dart';
import '../../core/widgets/asset_thumbnail.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/family_code_sheet.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/platform_fee_note.dart';
import '../activity/receipt_sheet.dart';
import '../held/held_payment_screen.dart';
import 'amount_keypad.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// Send flow: amount in real tokens (USDC / EURC), plus token toggle.
/// Recipient by @username / email / 0x.
class SendScreen extends StatefulWidget {
  const SendScreen({
    super.key,
    this.onBack,
    this.isFund = false,
    this.initialTo,
  });

  final VoidCallback? onBack;
  final bool isFund;

  /// Who to pay, when Send is opened from a link or a card ("Pay @name").
  final String? initialTo;

  @override
  State<SendScreen> createState() => _SendScreenState();
}

class _SendScreenState extends State<SendScreen> {
  CalcState _calc = CalcState.empty;
  final _to = TextEditingController();
  final _memo = TextEditingController();

  /// Settlement token on Arc: USDC or EURC (keypad = token amount).
  String _token = 'USDC';

  /// The contact behind the name in the To field, when one was picked.
  ///
  /// Tapping a contact used to write their raw address into the field, so the
  /// person you chose became a hex string on screen and stayed one all the way
  /// to the button. Keeping the contact here lets the field show the name
  /// while the address is still what gets paid.
  SavedContact? _picked;

  /// What actually gets paid: the picked contact's address, or whatever was
  /// typed if nobody was picked.
  /// Who the money goes to. A typed handle is read the same with or without
  /// its @ and in any case, so "Ekuma" pays @ekuma.
  String get _target => _picked?.address ?? normalizePayee(_to.text);

  /// Left behind to cover the fee, which on Arc is paid in USDC. Same figure
  /// Bridge uses.
  static const _arcUsdcGasReserve = 0.05;

  @override
  void initState() {
    super.initState();
    final to = widget.initialTo?.trim();
    if (to != null && to.isNotEmpty) _to.text = to;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<ContactsService>().refresh();
    });
  }

  @override
  void dispose() {
    _to.dispose();
    _memo.dispose();
    super.dispose();
  }

  Future<void> _promptSaveContact(String address) async {
    final nameCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Save address?'),
        content: TextField(
          controller: nameCtrl,
          decoration: const InputDecoration(labelText: 'Name (e.g. Mom)'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Skip')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Save')),
        ],
      ),
    );
    if (ok == true && nameCtrl.text.trim().isNotEmpty && mounted) {
      await context.read<ContactsService>().add(
            name: nameCtrl.text.trim(),
            address: address,
          );
    }
  }

  /// Dollars are typed in the person's main currency: ₦2,000 on the keypad
  /// sends the dollar equivalent. Euros are a balance of their own and are
  /// typed as euros.
  bool _typesInNaira(FxService fx) => _token == 'USDC' && fx.isNaira;

  double _tokenAmount(FxService fx) {
    final v = _calc.value ?? 0.0;
    if (v <= 0) return 0;
    return _token == 'USDC' ? fx.toUsd(v) : v;
  }

  /// The figure on the amount card: a currency symbol, not a ticker.
  String _primaryLabel(FxService fx) {
    final sign = _token == 'EURC' ? '€' : (_typesInNaira(fx) ? '₦' : r'$');
    final v = _calc.value ?? 0;
    return v > 0 ? '$sign${_calc.display}' : '${sign}0';
  }

  String _secondaryLabel(FxService fx) {
    final v = _calc.value ?? 0.0;
    if (v <= 0) {
      return _token == 'EURC' ? 'Enter an amount in euros' : 'Enter an amount';
    }
    if (_token == 'EURC') {
      return '≈ ${fx.secondaryToken(v, 'EURC')}';
    }
    // The other currency underneath: dollars under naira, naira under dollars.
    return '≈ ${fx.secondary(_tokenAmount(fx))}';
  }

  /// Quick amounts in whatever the keypad is typing.
  List<String> _quickAmounts(FxService fx) => _typesInNaira(fx)
      ? const ['1000', '5000', '10000']
      : const ['20', '50', '100'];

  /// Whole amounts without ".00" — a chip is a quarter of the row, and
  /// "₦10,000.00" does not fit in it.
  String _quickLabel(FxService fx, String q) {
    final v = double.parse(q);
    final sign = _token == 'EURC' ? '€' : (_typesInNaira(fx) ? '₦' : r'$');
    return '$sign${NumberFormat.decimalPattern('en_US').format(v)}';
  }

  /// Asks before paying someone who has no account yet.
  ///
  /// The two facts that decide it for a person are that the money leaves now
  /// and that it comes back if nobody claims it, so both are stated plainly
  /// rather than left to a help page.
  Future<bool?> _confirmHold(String email, double amount, String token) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('They are not on Evabob yet'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('$email does not have an account.'),
            const SizedBox(height: 12),
            Text(
              'We can hold ${formatMoney(amount, token)} '
              'for them and email them how to claim it. The money leaves your '
              'balance now.',
            ),
            const SizedBox(height: 12),
            const Text(
              'If they do not claim it within a week, it comes back to you '
              'automatically.',
              style: TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
            ),
            PlatformFeeNote(
              amount: amount,
              token: token,
              padding: const EdgeInsets.only(top: 12),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Hold it for them'),
          ),
        ],
      ),
    );
  }

  Future<void> _showSendOutcome({
    required String title,
    required String message,
    required IconData icon,
    bool error = false,
    String primaryLabel = 'Done',
    String? secondaryLabel,
    VoidCallback? onSecondary,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (sheetContext) => Container(
        constraints: BoxConstraints(
          minHeight: MediaQuery.sizeOf(sheetContext).height * .56,
        ),
        padding: EdgeInsets.fromLTRB(
          20,
          8,
          20,
          20 + MediaQuery.paddingOf(sheetContext).bottom,
        ),
        decoration: const BoxDecoration(
          color: EvabobColors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: EvabobColors.hairline,
                borderRadius: BorderRadius.circular(999),
              ),
            ),
            const SizedBox(height: 48),
            CircleAvatar(
              radius: 44,
              backgroundColor:
                  error ? const Color(0x14CF3345) : EvabobColors.blueSoft,
              child: Icon(
                icon,
                size: 38,
                color: error ? EvabobColors.alert : EvabobColors.ink,
              ),
            ),
            const SizedBox(height: 24),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 24,
                height: 32 / 24,
                color: EvabobColors.ink,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 14,
                height: 18 / 14,
                color: EvabobColors.inkMuted,
              ),
            ),
            const SizedBox(height: 36),
            SizedBox(
              width: double.infinity,
              height: 56,
              child: FilledButton(
                onPressed: () => Navigator.pop(sheetContext),
                child: Text(primaryLabel),
              ),
            ),
            if (secondaryLabel != null && onSecondary != null) ...[
              const SizedBox(height: 8),
              TextButton(
                onPressed: () {
                  Navigator.pop(sheetContext);
                  onSecondary();
                },
                child: Text(secondaryLabel),
              ),
            ],
          ],
        ),
      ),
    );
  }

  bool _hasEnoughMoney(
    WalletService wallet,
    AppFeatures features,
    double amount,
  ) {
    final withFee = amount * (1 + features.platformFeeBps / 10000);
    if (_token == 'EURC') {
      return wallet.eurcWallet >= withFee &&
          wallet.usdcWallet >= _arcUsdcGasReserve;
    }
    return wallet.usdcWallet >= withFee + _arcUsdcGasReserve;
  }

  static String _shortAddress(String a) =>
      a.length > 16 ? '${a.substring(0, 8)}…${a.substring(a.length - 6)}' : a;

  /// Builds the review shown before the PIN.
  ///
  /// Names the payee the best way we can — a saved contact, then whatever was
  /// typed — and shows the address only as something to check against. A payee
  /// with no prior payment in the activity history is treated as new, which
  /// adds the acknowledgement step.
  PaymentReview _buildReview(
    double amount,
    List<ActivityEntry> history, {
    PayeeCheck? check,
  }) {
    final typed = _to.text.trim();
    final target = _target;
    // The server's check covers every payment ever made, not just the page of
    // activity loaded on this phone, so it wins when it answered.
    String bare(String v) =>
        v.trim().replaceFirst(RegExp(r'^@'), '').toLowerCase();
    final paidBefore = check?.paidBefore ??
        history.any((e) => bare(e.counterparty ?? '') == bare(target));

    final isAddress = target.startsWith('0x');
    // Who it really is, as the server resolved it: a display name with the
    // handle to check against, rather than only what was typed.
    final resolvedName = check?.displayName;
    final name = _picked?.name ??
        resolvedName ??
        (isAddress ? (check?.label ?? _shortAddress(target)) : typed);
    // Repeating the address under itself gives nothing extra to check, so the
    // chip only appears when the name and the address are different things.
    final detail = check != null && (resolvedName != null || _picked != null)
        ? [
            if (check.label.isNotEmpty && check.label != name) check.label,
            _shortAddress(check.address),
          ].join(' · ')
        : (isAddress && _picked != null ? _shortAddress(target) : null);

    // A cooling-off hold pays an Evabob account in dollars; it is offered
    // only there, and switched on by default for someone never paid before.
    final coolingOff =
        check != null && check.coolingOffAvailable && _token == 'USDC';

    final memo = _memo.text.trim();
    return PaymentReview(
      payee: name,
      payeeDetail: detail,
      payeePhotoUrl: check?.avatarUrl,
      amount: amount,
      token: _token,
      firstTime: !paidBefore,
      cautions: check?.cautions ?? const [],
      coolingOffMinutes: coolingOff ? check.coolingOffMinutes : null,
      coolingOffDefault: coolingOff && check.coolingOffRecommended,
      note: memo.isEmpty
          ? 'It usually arrives in about a second.'
          : 'Memo: $memo\nIt usually arrives in about a second.',
    );
  }

  /// Sends through a cooling-off hold, then shows it with its countdown and a
  /// Cancel button — the one place the sender can still take it back.
  Future<void> _sendWithCoolingOff({
    required CircleWalletService circle,
    required ActivityService activity,
    required WalletService walletSvc,
    required PayeeCheck check,
    required double amount,
  }) async {
    final recipient = check.holdRecipient;
    if (recipient == null || recipient.isEmpty) return;
    final held = await circle.holdForRecipient(
      context: context,
      recipient: recipient,
      amountUsdc: amount,
      purpose: 'cooling_off',
      memo: _memo.text.trim().isEmpty ? null : _memo.text.trim(),
    );
    if (!mounted) return;
    if (held['ok'] != true) {
      await _showSendOutcome(
        title: "Didn't land",
        message: friendlyError(
          held['error'],
          fallback: 'The payment did not go through. Nothing left your wallet.',
        ),
        icon: Icons.close_rounded,
        error: true,
        primaryLabel: 'Try again',
      );
      return;
    }
    await walletSvc.refreshBalances(addressOverride: circle.address);
    await activity.refresh();
    final transferId = held['transferId']?.toString();
    if (!mounted) return;
    if (transferId != null && transferId.isNotEmpty) {
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => HeldPaymentScreen(transferId: transferId),
        ),
      );
    }
    if (mounted) widget.onBack?.call();
  }

  Future<void> _pickCurrency() async {
    final selected = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: EvabobColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Choose currency',
                style: TextStyle(fontSize: 22, color: EvabobColors.ink),
              ),
              const SizedBox(height: 16),
              for (final token in const ['USDC', 'EURC'])
                ListTile(
                  minTileHeight: 56,
                  contentPadding: EdgeInsets.zero,
                  leading: AssetThumbnail(asset: token, size: 36),
                  title: Text(token == 'EURC' ? 'Euros' : 'Dollars'),
                  trailing: token == _token
                      ? const Icon(
                          Icons.check_rounded,
                          color: EvabobColors.blue,
                        )
                      : null,
                  onTap: () => Navigator.of(context).pop(token),
                ),
            ],
          ),
        ),
      ),
    );
    if (selected != null && selected != _token && mounted) {
      setState(() {
        _token = selected;
        _calc = CalcState.empty;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    final contacts = context.watch<ContactsService>();
    final wallet = context.watch<WalletService>();
    final amount = _tokenAmount(fx);
    // More than they have: said as they type, not after they press Send.
    final tooMuch = !widget.isFund &&
        amount > 0 &&
        !_hasEnoughMoney(wallet, context.watch<AppFeatures>(), amount);
    final canSend =
        amount > 0 && !tooMuch && (widget.isFund || _to.text.trim().isNotEmpty);
    final query = _to.text.trim();
    final searching = !widget.isFund && query.isNotEmpty && _picked == null;
    final matches = searching ? contacts.match(query) : <SavedContact>[];
    final balLabel = _token == 'EURC'
        ? 'Wallet ${formatMoney(wallet.eurcWallet, 'EURC')}'
        : 'Wallet ${formatUsdc(wallet.usdcWallet)}';

    return Scaffold(
      backgroundColor: Colors.transparent,
      // Tapping anywhere that is not a text field — the amount included —
      // closes the keyboard so the amount keypad is there to use.
      body: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onTap: () => FocusManager.instance.primaryFocus?.unfocus(),
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: EvabobPageHeader(
                  title: widget.isFund ? 'Add money' : 'Send money',
                  onBack: widget.onBack,
                  trailing: PressScale(
                    onTap: _pickCurrency,
                    child: const SizedBox.square(
                      dimension: 44,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: EvabobColors.white,
                          shape: BoxShape.circle,
                        ),
                        child: Icon(Icons.more_vert_rounded, size: 20),
                      ),
                    ),
                  ),
                ),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                  children: [
                    if (!widget.isFund) ...[
                      Glass(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'Send to',
                              style: TextStyle(
                                fontSize: 10,
                                color: EvabobColors.navyMuted,
                              ),
                            ),
                            Row(
                              children: [
                                Expanded(
                                  child: TextField(
                                    controller: _to,
                                    // Typing over a picked contact means they
                                    // are no longer who is being paid.
                                    onChanged: (_) =>
                                        setState(() => _picked = null),
                                    decoration: const InputDecoration(
                                      hintText: 'Name, @username or email',
                                      border: InputBorder.none,
                                      isDense: true,
                                    ),
                                    style: const TextStyle(
                                      fontSize: 14,
                                      color: EvabobColors.navy,
                                    ),
                                  ),
                                ),
                                IconButton(
                                  tooltip: 'Scan QR',
                                  onPressed: () async {
                                    final hit = await AddressScanSheet.open(
                                      context,
                                      title: 'Scan payee',
                                    );
                                    if (hit != null &&
                                        hit.payee.isNotEmpty &&
                                        mounted) {
                                      setState(() {
                                        _picked = null;
                                        _to.text = hit.payee;
                                      });
                                    }
                                  },
                                  icon: const Icon(
                                    Icons.qr_code_scanner_rounded,
                                    color: EvabobColors.blue,
                                  ),
                                ),
                              ],
                            ),
                            if (searching) const Divider(height: 16),
                            if (searching && contacts.loading)
                              const Padding(
                                padding: EdgeInsets.symmetric(vertical: 12),
                                child: LinearProgressIndicator(minHeight: 2),
                              )
                            else if (searching && matches.isEmpty)
                              Padding(
                                padding: const EdgeInsets.fromLTRB(0, 8, 0, 4),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    const CircleAvatar(
                                      radius: 18,
                                      backgroundColor: EvabobColors.blueSoft,
                                      child: Icon(
                                        Icons.search_off_rounded,
                                        size: 18,
                                        color: EvabobColors.ink,
                                      ),
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          const Text(
                                            'No saved match',
                                            style: TextStyle(
                                              fontSize: 14,
                                              color: EvabobColors.ink,
                                            ),
                                          ),
                                          const SizedBox(height: 2),
                                          Text(
                                            query.contains('@') ||
                                                    query.startsWith('0x')
                                                ? 'You can still continue with what you entered.'
                                                : 'Try a handle, email, or wallet address.',
                                            style: const TextStyle(
                                              fontSize: 10,
                                              color: EvabobColors.inkTertiary,
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              )
                            else
                              ...matches.take(5).map(
                                    (c) => ListTile(
                                      dense: true,
                                      minTileHeight: 56,
                                      contentPadding: EdgeInsets.zero,
                                      leading: CircleAvatar(
                                        radius: 18,
                                        backgroundColor: EvabobColors.blueSoft,
                                        child: Text(
                                          c.name.isEmpty
                                              ? '?'
                                              : c.name[0].toUpperCase(),
                                          style: const TextStyle(
                                            color: EvabobColors.ink,
                                          ),
                                        ),
                                      ),
                                      title: Text(
                                        c.name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                      subtitle: Text(
                                        c.email?.isNotEmpty == true
                                            ? c.email!
                                            : _shortAddress(c.address),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          fontSize: 10,
                                          color: EvabobColors.inkTertiary,
                                        ),
                                      ),
                                      trailing: const Icon(
                                        Icons.arrow_forward_rounded,
                                        size: 18,
                                        color: EvabobColors.blue,
                                      ),
                                      onTap: () {
                                        setState(() {
                                          _picked = c;
                                          _to.text = c.name;
                                        });
                                      },
                                    ),
                                  ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],
                    SizedBox(
                      height: 118,
                      child: Glass(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Text(
                              _primaryLabel(fx),
                              style: EvabobTheme.amountDisplay.copyWith(
                                color: tooMuch ? EvabobColors.alert : null,
                              ),
                            ),
                            const SizedBox(height: 2),
                            if (tooMuch)
                              Padding(
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 12),
                                child: Text(
                                  'More than you have · $balLabel',
                                  textAlign: TextAlign.center,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: EvabobColors.alert,
                                  ),
                                ),
                              ),
                            InkWell(
                              onTap: _pickCurrency,
                              borderRadius: BorderRadius.circular(999),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 4,
                                ),
                                child: Text(
                                  '${_secondaryLabel(fx)} · tap to change currency',
                                  style: const TextStyle(
                                    fontSize: 10,
                                    color: EvabobColors.inkTertiary,
                                    letterSpacing: .2,
                                  ),
                                ),
                              ),
                            )
                                .animate(key: ValueKey('${_token}_$amount'))
                                .fadeIn(duration: 280.ms)
                                .slideY(
                                  begin: 0.2,
                                  end: 0,
                                  curve: Curves.easeOutCubic,
                                  duration: 320.ms,
                                ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        for (final q in [..._quickAmounts(fx), 'Max']) ...[
                          Expanded(
                            child: PressScale(
                              onTap: () {
                                if (q == 'Max') {
                                  // Fees on Arc come out of the same USDC, so
                                  // "Max" meaning the literal whole balance is a
                                  // send that cannot pay for itself. Bridge already
                                  // holds this much back; Send did not.
                                  final available = _token == 'EURC'
                                      ? (wallet.eurcWallet > 0
                                          ? wallet.eurcWallet
                                          : 0.0)
                                      : (wallet.usdcWallet > _arcUsdcGasReserve
                                          ? wallet.usdcWallet -
                                              _arcUsdcGasReserve
                                          : 0.0);
                                  // The Evabob fee is added on top, so "all of
                                  // it" is the largest amount that still leaves
                                  // room for its fee — rounded down, never up.
                                  final feeBps = context
                                      .read<AppFeatures>()
                                      .platformFeeBps;
                                  final maxVal =
                                      ((available / (1 + feeBps / 10000)) * 100)
                                              .floorToDouble() /
                                          100;
                                  // Shown in what the keypad types, rounded
                                  // down so it never exceeds the balance.
                                  final typed = _token == 'USDC'
                                      ? (fx.fromUsd(maxVal) * 100)
                                              .floorToDouble() /
                                          100
                                      : maxVal;
                                  final s = typed == typed.roundToDouble()
                                      ? typed.toStringAsFixed(0)
                                      : typed.toStringAsFixed(2);
                                  setState(() {
                                    _calc = CalcState(
                                      expression: s,
                                      display: s,
                                      value: typed,
                                    );
                                  });
                                } else {
                                  setState(() {
                                    _calc = CalcState(
                                      expression: q,
                                      display: q,
                                      value: double.parse(q),
                                    );
                                  });
                                }
                              },
                              child: Glass(
                                borderRadius: 999,
                                padding:
                                    const EdgeInsets.symmetric(vertical: 10),
                                child: FittedBox(
                                  fit: BoxFit.scaleDown,
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 8),
                                    child: Text(
                                      q == 'Max'
                                          ? 'All of it'
                                          : _quickLabel(fx, q),
                                      maxLines: 1,
                                      textAlign: TextAlign.center,
                                      style: const TextStyle(
                                        fontSize: 14,
                                        fontWeight: FontWeight.w400,
                                        color: EvabobColors.navyMuted,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                          if (q != 'Max') const SizedBox(width: 10),
                        ],
                      ],
                    ),
                    const SizedBox(height: 16),
                    if (!widget.isFund) ...[
                      SizedBox(
                        height: 56,
                        child: Glass(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          child: Row(
                            children: [
                              const Icon(
                                Icons.notes_rounded,
                                size: 19,
                                color: EvabobColors.blue,
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: TextField(
                                  controller: _memo,
                                  maxLength: 120,
                                  maxLines: 1,
                                  textInputAction: TextInputAction.done,
                                  decoration: const InputDecoration(
                                    hintText: 'Add a memo (optional)',
                                    counterText: '',
                                    border: InputBorder.none,
                                    enabledBorder: InputBorder.none,
                                    focusedBorder: InputBorder.none,
                                    contentPadding: EdgeInsets.zero,
                                  ),
                                  style: const TextStyle(
                                    fontSize: 14,
                                    color: EvabobColors.ink,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],
                    PressScale(
                      onTap: _pickCurrency,
                      child: SizedBox(
                        height: 72,
                        child: Glass(
                          child: Row(
                            children: [
                              AssetThumbnail(asset: _token, size: 36),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    const Text(
                                      'Paying from your balance',
                                      style: TextStyle(
                                        fontSize: 14,
                                        color: EvabobColors.ink,
                                      ),
                                    ),
                                    Text(
                                      '$balLabel available',
                                      style: const TextStyle(
                                        fontSize: 10,
                                        color: EvabobColors.inkTertiary,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              const Icon(
                                Icons.chevron_right_rounded,
                                color: EvabobColors.inkTertiary,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    AmountKeypad(
                      onKey: (k) {
                        FocusManager.instance.primaryFocus?.unfocus();
                        setState(() => _calc = applyKey(_calc, k));
                      },
                      canSend: canSend,
                      sendLabel: widget.isFund
                          ? (amount > 0
                              ? 'Fund ${formatMoney(amount)}'
                              : 'Enter amount')
                          : (amount > 0
                              ? 'Send ${formatMoney(amount, _token)}'
                              : 'Enter amount'),
                      onSend: canSend
                          ? () async {
                              final circle =
                                  context.read<CircleWalletService>();
                              final activity = context.read<ActivityService>();
                              final walletSvc = context.read<WalletService>();
                              try {
                                if (widget.isFund) {
                                  if (!mounted) return;
                                  showTopSnack(
                                    context,
                                    const SnackBar(
                                      content: Text(
                                        'Topping up this way is paused. Open Balances to get your details for receiving money.',
                                      ),
                                      behavior: SnackBarBehavior.floating,
                                    ),
                                  );
                                  return;
                                }
                                if (!_hasEnoughMoney(
                                  walletSvc,
                                  context.read<AppFeatures>(),
                                  amount,
                                )) {
                                  await _showSendOutcome(
                                    title: 'Not enough money',
                                    message:
                                        'Your balance does not cover ${formatMoney(amount, _token)} plus the payment fee and network reserve.',
                                    icon: Icons.account_balance_wallet_outlined,
                                    error: true,
                                    primaryLabel: 'Change amount',
                                  );
                                  return;
                                }
                                // Paying an email nobody has claimed yet is a
                                // different thing from paying a wallet, so ask
                                // rather than silently doing one or the other.
                                // The money is held until they sign up, and
                                // comes back if they never do.
                                final payee = _target;
                                if (payee.contains('@') &&
                                    !payee.startsWith('@')) {
                                  final st =
                                      await circle.recipientStatus(payee);
                                  if (!context.mounted) return;
                                  if (st['ok'] == true &&
                                      st['registered'] != true) {
                                    final hold = await _confirmHold(
                                      payee,
                                      amount,
                                      _token,
                                    );
                                    if (hold != true || !context.mounted) {
                                      return;
                                    }
                                    final held = await circle.holdForRecipient(
                                      context: context,
                                      recipient: payee,
                                      amountUsdc: amount,
                                      purpose: 'claim_link',
                                      memo: _memo.text.trim().isEmpty
                                          ? null
                                          : _memo.text.trim(),
                                    );
                                    if (!context.mounted) return;
                                    final ok = held['ok'] == true;
                                    if (ok) {
                                      await activity.refresh();
                                      await walletSvc.refreshBalances();
                                      if (context.mounted) {
                                        await _showSendOutcome(
                                          title: 'Held for them',
                                          message: held['emailed'] == true
                                              ? 'We emailed $payee a private link. The money stays safe until they claim it.'
                                              : '$payee can claim the money when they join Evabob.',
                                          icon: Icons.schedule_rounded,
                                        );
                                        widget.onBack?.call();
                                      }
                                    } else {
                                      await _showSendOutcome(
                                        title: "Didn't land",
                                        message: friendlyError(
                                          held['error'],
                                          fallback:
                                              'We could not hold that payment. Nothing left your wallet.',
                                        ),
                                        icon: Icons.close_rounded,
                                        error: true,
                                        primaryLabel: 'Try again',
                                      );
                                    }
                                    return;
                                  }
                                }
                                // Who this really is, whether they have been
                                // paid before, and whether the address only
                                // looks familiar — asked of the server before
                                // anything is shown, so the review can say so.
                                PayeeCheck? check;
                                try {
                                  check = await checkPayee(
                                    context.read<ApiClient>(),
                                    payee,
                                  );
                                } on ApiException catch (e) {
                                  if (!context.mounted) return;
                                  await _showSendOutcome(
                                    title: 'No match',
                                    message: friendlyError(
                                      e.message,
                                      fallback:
                                          'We could not find anyone with those details. Check the handle, email, or wallet address.',
                                    ),
                                    icon: Icons.person_search_outlined,
                                    error: true,
                                    primaryLabel: 'Try another search',
                                  );
                                  return;
                                }
                                if (!context.mounted) return;
                                // The PIN screen after this shows a title and
                                // nothing else — not the amount, not who is
                                // being paid. This is the last and only place
                                // both appear together, so it is where the
                                // "cannot be undone" has to be said.
                                final choice = await confirmPaymentChoice(
                                  context,
                                  _buildReview(
                                    amount,
                                    activity.items,
                                    check: check,
                                  ),
                                );
                                if (choice == null || !context.mounted) return;
                                // Family above the chosen amount: the code
                                // from email, before the PIN. The server
                                // decides, and refuses the send without it.
                                if (check == null || check.family) {
                                  final passed = await passFamilyCheck(
                                    context,
                                    to: payee,
                                    amount: amount,
                                    token: _token,
                                  );
                                  if (!passed || !context.mounted) return;
                                }
                                if (choice.coolingOff && check != null) {
                                  await _sendWithCoolingOff(
                                    circle: circle,
                                    activity: activity,
                                    walletSvc: walletSvc,
                                    check: check,
                                    amount: amount,
                                  );
                                  return;
                                }
                                final res = await circle.send(
                                  context: context,
                                  to: payee,
                                  amountUsdc: amount,
                                  token: _token,
                                  memo: _memo.text.trim().isEmpty
                                      ? null
                                      : _memo.text.trim(),
                                );
                                if (!context.mounted) return;
                                if (res['ok'] == true) {
                                  final activityId =
                                      res['activityId']?.toString();
                                  final txHint = res['txHash']?.toString() ??
                                      res['transactionHash']?.toString();
                                  if (activityId != null &&
                                      txHint != null &&
                                      txHint.isNotEmpty) {
                                    await activity.attachTxHash(
                                      activityId,
                                      txHint,
                                    );
                                  }
                                  await walletSvc.refreshBalances(
                                    addressOverride: circle.address,
                                  );
                                  await activity.refresh();
                                  final mode = res['mode']?.toString() ?? '';
                                  var msg = res['message']?.toString() ??
                                      'Sent ${formatMoney(amount, _token)}';
                                  // Surface claim-email result for unregistered email
                                  if (mode == 'escrow') {
                                    final notify = res['notify'];
                                    if (notify is Map) {
                                      final sent = notify['emailSent'] == true;
                                      final detail =
                                          notify['detail']?.toString() ?? '';
                                      if (sent) {
                                        msg =
                                            'Waiting for them to join — we sent them an email';
                                      } else if (detail.isNotEmpty) {
                                        msg =
                                            'Held safely — email not sent: ${shortUiText(detail, max: 80)}';
                                      }
                                    }
                                  }
                                  if (!context.mounted) return;
                                  // The proof link, one tap from the moment
                                  // the seller asks "has it come?". Opened from
                                  // the root navigator: this screen closes next.
                                  final sent = activity.items
                                      .where((e) => e.id == activityId)
                                      .firstOrNull;
                                  final rootNav = Navigator.of(context,
                                      rootNavigator: true);
                                  final dest =
                                      res['destinationAddress']?.toString();
                                  final promptSave =
                                      res['promptSave'] == true ||
                                          mode == 'direct_evm';
                                  if (promptSave &&
                                      dest != null &&
                                      dest.startsWith('0x')) {
                                    await _promptSaveContact(dest);
                                  }
                                  if (!context.mounted) return;
                                  final status =
                                      res['status']?.toString().toLowerCase() ??
                                          '';
                                  final onTheWay = const {
                                    'pending',
                                    'processing',
                                    'submitted',
                                    'in_progress',
                                  }.contains(status);
                                  // A direct payment gets the full receipt
                                  // screens (Figma "Send · On the way" /
                                  // "Send · Sent"); money held for someone
                                  // without an account keeps its own sheet.
                                  if (mode != 'escrow') {
                                    final name = sent?.personName ??
                                        check?.displayName ??
                                        _picked?.name ??
                                        _to.text.trim();
                                    await showSendResult(
                                      context,
                                      SendResult(
                                        amount: amount,
                                        token: _token,
                                        fee: sent?.platformFee ??
                                            context
                                                .read<AppFeatures>()
                                                .platformFeeFor(amount),
                                        recipientName: name,
                                        recipientAvatarUrl:
                                            sent?.personAvatarUrl ??
                                                check?.avatarUrl,
                                        recipientAvatarBundle:
                                            sent?.personAvatarBundle,
                                        activityId: activityId,
                                        txHash: txHint ?? sent?.txHash,
                                      ),
                                      onTheWay: onTheWay,
                                    );
                                    widget.onBack?.call();
                                    return;
                                  }
                                  await _showSendOutcome(
                                    title: mode == 'escrow'
                                        ? 'Held for them'
                                        : onTheWay
                                            ? 'On the way'
                                            : 'Sent',
                                    message: shortUiText(msg, max: 180),
                                    icon: mode == 'escrow' || onTheWay
                                        ? Icons.arrow_upward_rounded
                                        : Icons.check_rounded,
                                    secondaryLabel:
                                        sent != null && sent.shareable
                                            ? 'View receipt'
                                            : null,
                                    onSecondary: sent != null && sent.shareable
                                        ? () => ReceiptSheet.open(
                                              rootNav.context,
                                              sent,
                                            )
                                        : null,
                                  );
                                  widget.onBack?.call();
                                } else {
                                  final err = friendlyError(
                                    res['error'],
                                    fallback: 'The payment did not go through.',
                                  );
                                  await _showSendOutcome(
                                    title: "Didn't land",
                                    message: '$err Nothing left your wallet.',
                                    icon: Icons.close_rounded,
                                    error: true,
                                    primaryLabel: 'Try again',
                                  );
                                }
                              } catch (e) {
                                if (!context.mounted) return;
                                await _showSendOutcome(
                                  title: "Didn't land",
                                  message:
                                      '${friendlyError(e, fallback: 'The payment did not go through.')} Nothing left your wallet.',
                                  icon: Icons.close_rounded,
                                  error: true,
                                  primaryLabel: 'Try again',
                                );
                              }
                            }
                          : null,
                    ),
                    if (!widget.isFund) ...[
                      const SizedBox(height: 10),
                      Text(
                        _token == 'EURC'
                            ? 'Pay anyone by @username or email. Paste an '
                                'account address to pay a wallet outside Evabob.'
                            : 'Pay anyone by @username or email. If they are not '
                                'on Evabob yet, we hold it until they join.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 10,
                          color: EvabobColors.chalk,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
