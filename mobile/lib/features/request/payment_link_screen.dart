import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/fx/fx_service.dart';
import '../../core/activity/activity_service.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/family_code_sheet.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import '../../core/config/app_features.dart';
import 'request_paid_screen.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:intl/intl.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/bundle_avatar.dart';

class PaymentLinkScreen extends StatefulWidget {
  const PaymentLinkScreen({
    super.key,
    required this.requestId,
    required this.onBack,
  });

  final String requestId;
  final VoidCallback onBack;

  @override
  State<PaymentLinkScreen> createState() => _PaymentLinkScreenState();
}

class _PaymentLinkScreenState extends State<PaymentLinkScreen> {
  Map<String, dynamic>? _invoice;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final value = await context
          .read<ApiClient>()
          .get('/v1/payment-requests/${widget.requestId}');
      if (!mounted) return;
      setState(() => _invoice = value);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = friendlyError(
            error,
            fallback: 'This payment request is not available.',
          ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pay() async {
    final invoice = _invoice;
    if (invoice == null || _busy) return;
    final payee = invoice['payee'] is Map
        ? Map<String, dynamic>.from(invoice['payee'] as Map)
        : <String, dynamic>{};
    final address = payee['address']?.toString() ?? '';
    final label = payee['label']?.toString() ?? 'Evabob user';
    final amount = (invoice['total'] as num?)?.toDouble() ??
        (invoice['amount'] as num?)?.toDouble() ??
        0;
    final token = invoice['token']?.toString() == 'EURC' ? 'EURC' : 'USDC';
    if (!address.startsWith('0x') || amount <= 0) {
      setState(() => _error =
          'The person who created this request cannot receive money yet.');
      return;
    }
    final approved = await confirmPayment(
      context,
      PaymentReview(
        payee: label,
        payeeDetail:
            '${address.substring(0, 8)}…${address.substring(address.length - 6)}',
        amount: amount,
        token: token,
        note: (invoice['note']?.toString().trim().isNotEmpty ?? false)
            ? 'Memo: ${invoice['note']}'
            : null,
      ),
    );
    if (!approved || !mounted) return;
    if (!await passFamilyCheck(context,
            to: address, amount: amount, token: token) ||
        !mounted) {
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await context.read<CircleWalletService>().send(
            context: context,
            to: address,
            amountUsdc: amount,
            token: token,
            memo: invoice['note']?.toString(),
          );
      if (!mounted) return;
      if (result['ok'] != true) {
        throw Exception(
            result['error']?.toString() ?? 'Payment did not complete');
      }
      final txHash = result['txHash']?.toString() ??
          result['transactionHash']?.toString() ??
          '';
      if (!txHash.startsWith('0x')) {
        throw Exception(
            'Payment is still confirming. Check Activity before retrying.');
      }
      await context.read<ApiClient>().post(
        '/v1/payment-requests/${widget.requestId}/mark',
        body: {
          'status': 'paid',
          'paidTxHash': txHash,
          if (invoice['threadId'] != null) 'threadId': invoice['threadId'],
        },
      );
      if (!mounted) return;
      await Future.wait([
        context.read<ActivityService>().refresh(),
        context.read<WalletService>().refreshBalances(
              addressOverride: context.read<CircleWalletService>().address,
            ),
      ]);
      if (!mounted) return;
      // The receipt (Figma "Request · Pay"), in the payer's own currency.
      final fx = context.read<FxService>();
      final display = invoice['display'] is Map
          ? Map<String, dynamic>.from(invoice['display'] as Map)
          : const <String, dynamic>{};
      final fee = context.read<AppFeatures>().platformFeeFor(amount);
      await RequestPaidScreen.open(
        context,
        payee: label.replaceFirst('@', '').split(' ').first,
        amount: fx.requestPrimary(
          usd: amount,
          token: token,
          displayCurrency: display['currency']?.toString(),
          displayAmount: (display['amount'] as num?)?.toDouble(),
        ),
        fee: fee > 0 ? fx.primaryToken(fee, token) : null,
        forWhat: invoice['description']?.toString(),
      );
      if (!mounted) return;
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = friendlyError(
            error,
            fallback: 'The payment did not go through.',
          ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Pays by milestone: each line set aside on its own and paid to the
  /// sender as that part is delivered.
  Future<void> _payByMilestone() async {
    final invoice = _invoice;
    if (invoice == null || _busy) return;
    final payee = invoice['payee'] is Map
        ? Map<String, dynamic>.from(invoice['payee'] as Map)
        : <String, dynamic>{};
    final label = payee['label']?.toString() ?? 'Evabob user';
    final address = payee['address']?.toString() ?? '';
    final amount = (invoice['total'] as num?)?.toDouble() ?? 0;
    final lines = (invoice['items'] as List? ?? const []).length;
    final approved = await confirmPayment(
      context,
      PaymentReview(
        payee: label,
        amount: amount,
        action: 'Set aside',
        warning: 'The money leaves your balance now, in $lines parts. Each '
            'part reaches $label only when that milestone is delivered, or '
            '7 days after it is marked delivered if you say nothing. You can '
            'cancel any part before it is delivered.',
        landedLabel: 'Set aside for $label',
      ),
    );
    if (!approved || !mounted) return;
    if (address.startsWith('0x') &&
        (!await passFamilyCheck(context, to: address, amount: amount) ||
            !mounted)) {
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await context
          .read<CircleWalletService>()
          .holdMilestones(context: context, paymentRequestId: widget.requestId);
      if (!mounted) return;
      if (res['ok'] != true) {
        throw Exception(
            res['error']?.toString() ?? 'The milestones were not set aside');
      }
      await Future.wait([
        context.read<ActivityService>().refresh(),
        context.read<WalletService>().refreshBalances(
              addressOverride: context.read<CircleWalletService>().address,
            ),
      ]);
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text('Set aside in $lines parts. Each is paid as it is '
              'delivered — follow them in Activity.'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = friendlyError(
            error,
            fallback: 'The milestones were not set aside.',
          ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Says no to the request: it closes for both people and the asker is told.
  Future<void> _decline() async {
    if (_busy) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Decline this request?'),
        content: const Text('They will see that you declined it. Nothing is '
            'paid.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Keep it'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Decline'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await context
          .read<ApiClient>()
          .post('/v1/payment-requests/${widget.requestId}/decline');
      if (!mounted) return;
      setState(() => _busy = false);
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() => _error =
          friendlyError(error, fallback: 'The request was not declined.'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  static String _asked(DateTime at) {
    final now = DateTime.now();
    final today =
        at.year == now.year && at.month == now.month && at.day == now.day;
    final yesterday = now.subtract(const Duration(days: 1));
    final wasYesterday = at.year == yesterday.year &&
        at.month == yesterday.month &&
        at.day == yesterday.day;
    final time = DateFormat('H:mm').format(at);
    if (today) return 'Today at $time';
    if (wasYesterday) return 'Yesterday at $time';
    return '${DateFormat('d MMM').format(at)} at $time';
  }

  /// Figma "Request · Detail" (52:2358): who is asking, how much, for what,
  /// then Pay and a way to say no.
  @override
  Widget build(BuildContext context) {
    final invoice = _invoice;
    final amount = (invoice?['total'] as num?)?.toDouble() ??
        (invoice?['amount'] as num?)?.toDouble() ??
        0;
    final token = invoice?['token']?.toString() == 'EURC' ? 'EURC' : 'USDC';
    // The payer's own currency — exactly as asked when it is the same one.
    final display = invoice?['display'] is Map
        ? Map<String, dynamic>.from(invoice!['display'] as Map)
        : const <String, dynamic>{};
    final fx = context.watch<FxService>();
    final shown = fx.requestPrimary(
      usd: amount,
      token: token,
      displayCurrency: display['currency']?.toString(),
      displayAmount: (display['amount'] as num?)?.toDouble(),
    );
    final status = invoice?['status']?.toString() ?? '';
    final open = status == 'open';
    final payee = invoice?['payee'] is Map
        ? Map<String, dynamic>.from(invoice!['payee'] as Map)
        : <String, dynamic>{};
    final handle = payee['handle']?.toString() ??
        ((payee['label']?.toString() ?? '').startsWith('@')
            ? payee['label'].toString()
            : null);
    final fullName = (payee['name']?.toString().trim().isNotEmpty ?? false)
        ? payee['name'].toString().trim()
        : (handle ?? payee['label']?.toString() ?? 'Someone');
    final first = fullName.startsWith('@')
        ? fullName.substring(1)
        : fullName.split(RegExp(r'\s+')).first;
    final byMilestone = (invoice?['allowedStructures'] as List? ?? const [])
        .contains('milestones');
    final dueAt = DateTime.tryParse(invoice?['dueAt']?.toString() ?? '');
    final askedAt =
        DateTime.tryParse(invoice?['createdAt']?.toString() ?? '')?.toLocal();
    final items = [
      for (final raw in (invoice?['items'] as List? ?? const []))
        if (raw is Map) Map<String, dynamic>.from(raw),
    ];
    final description = (invoice?['description']?.toString().trim() ?? '')
            .isNotEmpty
        ? invoice!['description'].toString().trim()
        : items.length == 1
            ? (items.first['description']?.toString().trim() ?? '')
            : '';
    final fee = context.read<AppFeatures>().platformFeeFor(amount);
    final note = invoice?['note']?.toString().trim() ?? '';

    final headline = invoice == null
        ? (_error != null ? 'Request unavailable' : '')
        : switch (status) {
            'open' => '$first is asking for',
            'paid' => 'You paid $first',
            'declined' => 'You declined this request',
            'cancelled' => '$first cancelled this request',
            _ => 'This request is $status',
          };

    final rows = <(String, String)>[
      if (items.length > 1)
        for (final item in items)
          (
            item['description']?.toString() ?? 'Item',
            formatMoney((item['amount'] as num?)?.toDouble() ?? 0, token),
          ),
      if (askedAt != null) ('Asked', _asked(askedAt)),
      if (open && dueAt != null)
        (
          'Due',
          MaterialLocalizations.of(context).formatMediumDate(dueAt.toLocal()),
        ),
      if (open) ('Pay from', 'Spendable balance'),
      if (open) ('Fee', fee > 0 ? fx.primaryToken(fee, token) : 'Free'),
    ];

    Widget row(String label, String value, {bool overdue = false}) =>
        SizedBox(
          height: 52,
          child: Row(
            children: [
              Expanded(
                child: Text(label,
                    style: Type.body, overflow: TextOverflow.ellipsis),
              ),
              const SizedBox(width: 16),
              Text(
                value,
                textAlign: TextAlign.right,
                style: Type.body.copyWith(
                  color: overdue ? EvabobColors.alert : EvabobColors.slate,
                ),
              ),
            ],
          ),
        );

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            _FigmaHeader(title: 'Request', onBack: widget.onBack),
            Expanded(
              child: _busy && invoice == null
                  ? const Center(
                      child:
                          CircularProgressIndicator(color: EvabobColors.blue))
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(20, 22, 20, 32),
                      children: [
                        Center(
                          child: PeerAvatar(
                            name: fullName,
                            avatarUrl: payee['avatarUrl']?.toString(),
                            bundleIndex:
                                (payee['avatarBundle'] as num?)?.toInt(),
                            size: 56,
                          ),
                        ),
                        const SizedBox(height: 20),
                        Text(
                          headline,
                          textAlign: TextAlign.center,
                          style: Type.title,
                        ),
                        if (handle != null) ...[
                          const SizedBox(height: 8),
                          Text(
                            handle,
                            textAlign: TextAlign.center,
                            style: Type.body
                                .copyWith(color: EvabobColors.inkTertiary),
                          ),
                        ],
                        const SizedBox(height: 26),
                        if (amount > 0)
                          FittedBox(
                            fit: BoxFit.scaleDown,
                            child: Text(shown, style: Type.hero),
                          ),
                        if (description.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          Text(
                            description.toLowerCase().startsWith('for ')
                                ? description
                                : 'For ${description[0].toLowerCase()}'
                                    '${description.substring(1)}',
                            textAlign: TextAlign.center,
                            style:
                                Type.body.copyWith(color: EvabobColors.slate),
                          ),
                        ],
                        const SizedBox(height: 30),
                        if (rows.isNotEmpty)
                          Container(
                            padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                            decoration: const BoxDecoration(
                              color: EvabobColors.white,
                              borderRadius:
                                  BorderRadius.all(Radius.circular(12)),
                              boxShadow: [
                                BoxShadow(
                                  color: Color(0x0F0B1620),
                                  blurRadius: 24,
                                  spreadRadius: -6,
                                ),
                              ],
                            ),
                            child: Column(
                              children: [
                                for (var i = 0; i < rows.length; i++) ...[
                                  if (i > 0)
                                    const Divider(
                                        height: 1,
                                        color: EvabobColors.hairline),
                                  row(
                                    rows[i].$1,
                                    rows[i].$2,
                                    overdue: rows[i].$1 == 'Due' &&
                                        dueAt != null &&
                                        dueAt.isBefore(DateTime.now()),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        if (note.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          Text(
                            note,
                            textAlign: TextAlign.center,
                            style: Type.label
                                .copyWith(color: EvabobColors.inkTertiary),
                          ),
                        ],
                        if (_error != null) ...[
                          const SizedBox(height: 16),
                          Text(_error!,
                              textAlign: TextAlign.center,
                              style: Type.body
                                  .copyWith(color: EvabobColors.alert)),
                        ],
                        const SizedBox(height: 88),
                        if (open && byMilestone) ...[
                          _BlueButton(
                            label: 'Set aside by milestone',
                            onPressed: !_busy ? _payByMilestone : null,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            'Each line is paid only when that part is '
                            'delivered. Or pay it all now:',
                            textAlign: TextAlign.center,
                            style: Type.label
                                .copyWith(color: EvabobColors.inkTertiary),
                          ),
                          const SizedBox(height: 8),
                        ],
                        if (open) ...[
                          _BlueButton(
                            label: 'Pay $shown',
                            onPressed: !_busy ? _pay : null,
                            busy: _busy,
                          ),
                          const SizedBox(height: 24),
                          Center(
                            child: GestureDetector(
                              onTap: _busy ? null : _decline,
                              child: Text(
                                'Decline this request',
                                style: Type.body
                                    .copyWith(color: EvabobColors.blue),
                              ),
                            ),
                          ),
                        ] else if (invoice == null)
                          _BlueButton(
                            label: 'Try again',
                            onPressed: _busy ? null : _load,
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

/// The Figma page header: a round back button and a centred title.
class _FigmaHeader extends StatelessWidget {
  const _FigmaHeader({this.title, required this.onBack});

  final String? title;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
      child: SizedBox(
        height: 44,
        child: Stack(
          alignment: Alignment.center,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: Semantics(
                button: true,
                label: 'Back',
                child: GestureDetector(
                  onTap: onBack,
                  child: SizedBox.square(
                    dimension: 44,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        SvgPicture.asset('assets/figma/btn_back.svg',
                            width: 44, height: 44),
                        const Text(
                          '‹',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontWeight: FontWeight.w900,
                            fontSize: 22,
                            height: 28 / 22,
                            color: EvabobColors.ink,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            if (title != null)
              Text(
                title!,
                style: Type.title.copyWith(
                  fontSize: 24,
                  height: 32 / 24,
                  letterSpacing: -0.4,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The Figma primary button: blue, 56 tall, with a soft blue glow.
class _BlueButton extends StatelessWidget {
  const _BlueButton({
    required this.label,
    required this.onPressed,
    this.busy = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: const BorderRadius.all(Radius.circular(12)),
        boxShadow: onPressed == null
            ? const []
            : const [
                BoxShadow(
                  color: Color(0x4700B5FF),
                  blurRadius: 24,
                  spreadRadius: -6,
                ),
              ],
      ),
      child: SizedBox(
        height: 56,
        width: double.infinity,
        child: FilledButton(
          onPressed: onPressed,
          style: FilledButton.styleFrom(
            backgroundColor: EvabobColors.blue,
            disabledBackgroundColor: EvabobColors.blueSoft,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
          ),
          child: busy
              ? const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: EvabobColors.white,
                  ),
                )
              : Text(
                  label,
                  style: Type.body.copyWith(color: EvabobColors.white),
                ),
        ),
      ),
    );
  }
}

class ClaimLinkScreen extends StatefulWidget {
  const ClaimLinkScreen({
    super.key,
    required this.transferId,
    required this.onBack,
  });

  final String transferId;
  final VoidCallback onBack;

  @override
  State<ClaimLinkScreen> createState() => _ClaimLinkScreenState();
}

/// Figma "Claim held money" (52:2403): who sent it, how much, the three steps
/// to get it, and when it goes back.
class _ClaimLinkScreenState extends State<ClaimLinkScreen> {
  Map<String, dynamic>? _claim;
  String? _error;
  bool _busy = false;
  bool _claiming = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() => _busy = true);
    try {
      final value = await context
          .read<ApiClient>()
          .get('/v1/public/claims/${widget.transferId}');
      if (!mounted) return;
      setState(() {
        _claim = value;
        _error = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error =
          friendlyError(error, fallback: 'This claim is not available.'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Signing in with the email it was sent to releases it: syncing the
  /// session asks the server to claim, then we watch until it has landed.
  Future<void> _claimIt() async {
    if (_claiming) return;
    setState(() {
      _claiming = true;
      _error = null;
    });
    final wallet = context.read<WalletService>();
    final address = context.read<CircleWalletService>().address;
    try {
      await wallet.syncSession();
      for (var i = 0; i < 12 && mounted; i++) {
        await Future<void>.delayed(const Duration(seconds: 3));
        if (!mounted) return;
        await _load();
        if (_claim?['status'] == 'claimed') break;
      }
      if (!mounted) return;
      if (_claim?['status'] == 'claimed') {
        await Future.wait([
          context.read<ActivityService>().refresh(),
          wallet.refreshBalances(addressOverride: address),
        ]);
      } else {
        setState(() => _error = 'Still on its way. It lands only in the '
            'account for the email it was sent to, so check you signed in '
            'with that email.');
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _error =
          friendlyError(error, fallback: 'We could not claim it just now.'));
    } finally {
      if (mounted) setState(() => _claiming = false);
    }
  }

  void _how() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: EvabobColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('How does this work?', style: Type.title),
              const SizedBox(height: 8),
              Text(
                'The money was sent to your email address and is held '
                'safely until you claim it. It is released only to the '
                'Evabob account signed in with that email. Nobody else '
                'can take it, and if it is not claimed in time it goes back '
                'to the sender.',
                textAlign: TextAlign.center,
                style: Type.body.copyWith(color: EvabobColors.slate),
              ),
              const SizedBox(height: 16),
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Close'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _since(DateTime at) {
    final days = DateTime.now().difference(at).inDays;
    if (days < 1) return 'today';
    if (days < 7) return DateFormat('EEEE').format(at);
    return DateFormat('d MMM').format(at);
  }

  static const _words = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  ];

  @override
  Widget build(BuildContext context) {
    final claim = _claim;
    final amount = (claim?['amount'] as num?)?.toDouble() ?? 0;
    final token = claim?['token']?.toString() ?? 'USDC';
    final money = amount > 0 ? formatTokenAmount(amount, token) : '';
    final status = claim?['status']?.toString() ?? '';
    final expired = claim?['expired'] == true;
    final pending = status == 'pending' && !expired;
    final sender = claim?['sender'] is Map
        ? Map<String, dynamic>.from(claim!['sender'] as Map)
        : const <String, dynamic>{};
    final senderName = sender['name']?.toString().trim() ?? '';
    final first = senderName.isEmpty
        ? 'Someone'
        : senderName.startsWith('@')
            ? senderName.substring(1)
            : senderName.split(RegExp(r'\s+')).first;
    final created =
        DateTime.tryParse(claim?['createdAt']?.toString() ?? '')?.toLocal();
    final expires =
        DateTime.tryParse(claim?['expiresAt']?.toString() ?? '')?.toLocal();
    final windowDays = created != null && expires != null
        ? expires.difference(created).inHours ~/ 24
        : 7;
    final window = windowDays >= 0 && windowDays < _words.length
        ? '${_words[windowDays]} ${windowDays == 1 ? 'day' : 'days'}'
        : '$windowDays days';

    final title = claim == null
        ? (_error != null ? 'This claim is not available' : '')
        : status == 'claimed'
            ? 'You claimed it'
            : status == 'refunded' || expired
                ? 'This went back to $first'
                : '$first sent you money';
    final sub = claim == null
        ? ''
        : status == 'claimed'
            ? 'It is in your spendable balance'
            : status == 'refunded' || expired
                ? 'Nobody claimed it in time'
                : created != null
                    ? 'Held for you since ${_since(created)}'
                    : 'Held for you';

    Widget step(int n, String text, {required bool done}) => SizedBox(
          height: 68,
          child: Row(
            children: [
              Container(
                width: 24,
                height: 24,
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  color: EvabobColors.pageBg,
                  shape: BoxShape.circle,
                ),
                child: done
                    ? const Icon(Icons.check_rounded,
                        size: 14, color: EvabobColors.blue)
                    : Text(
                        '$n',
                        style: Type.label.copyWith(color: EvabobColors.blue),
                      ),
              ),
              const SizedBox(width: 12),
              Expanded(child: Text(text, style: Type.body)),
            ],
          ),
        );

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            _FigmaHeader(onBack: widget.onBack),
            Expanded(
              child: _busy && claim == null
                  ? const Center(
                      child:
                          CircularProgressIndicator(color: EvabobColors.blue))
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(20, 22, 20, 32),
                      children: [
                        Center(
                          child: PeerAvatar(
                            name: senderName.isEmpty ? first : senderName,
                            avatarUrl: sender['avatarUrl']?.toString(),
                            bundleIndex:
                                (sender['avatarBundle'] as num?)?.toInt(),
                            size: 56,
                          ),
                        ),
                        const SizedBox(height: 20),
                        Text(
                          title,
                          textAlign: TextAlign.center,
                          style: Type.title.copyWith(
                            fontSize: 24,
                            height: 32 / 24,
                            letterSpacing: -0.4,
                          ),
                        ),
                        if (money.isNotEmpty) ...[
                          const SizedBox(height: 16),
                          FittedBox(
                            fit: BoxFit.scaleDown,
                            child: Text(money, style: Type.hero),
                          ),
                        ],
                        const SizedBox(height: 8),
                        Text(
                          sub,
                          textAlign: TextAlign.center,
                          style: Type.body.copyWith(color: EvabobColors.slate),
                        ),
                        const SizedBox(height: 28),
                        if (pending)
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 16),
                            decoration: const BoxDecoration(
                              color: EvabobColors.white,
                              borderRadius:
                                  BorderRadius.all(Radius.circular(12)),
                              boxShadow: [
                                BoxShadow(
                                  color: Color(0x0F0B1620),
                                  blurRadius: 24,
                                  spreadRadius: -6,
                                ),
                              ],
                            ),
                            child: Column(
                              children: [
                                // In the app they have already done the first
                                // two: they are signed in and have a PIN.
                                step(1, 'Set up Evabob with your email',
                                    done: true),
                                const Divider(
                                    height: 1, color: EvabobColors.hairline),
                                step(2, 'Pick a PIN so only you can spend it',
                                    done: true),
                                const Divider(
                                    height: 1, color: EvabobColors.hairline),
                                step(3, 'The $money lands straight away',
                                    done: false),
                              ],
                            ),
                          ),
                        if (pending) ...[
                          const SizedBox(height: 28),
                          Text(
                            'If nobody claims it in $window it goes back to '
                            '$first.',
                            textAlign: TextAlign.center,
                            style:
                                Type.body.copyWith(color: EvabobColors.slate),
                          ),
                        ],
                        if (_error != null) ...[
                          const SizedBox(height: 16),
                          Text(
                            _error!,
                            textAlign: TextAlign.center,
                            style:
                                Type.body.copyWith(color: EvabobColors.alert),
                          ),
                        ],
                        const SizedBox(height: 24),
                        if (pending)
                          _BlueButton(
                            label: 'Claim $money',
                            onPressed: _claiming ? null : _claimIt,
                            busy: _claiming,
                          )
                        else
                          _BlueButton(
                            label: claim == null ? 'Try again' : 'Done',
                            onPressed: _busy
                                ? null
                                : claim == null
                                    ? _load
                                    : widget.onBack,
                          ),
                        const SizedBox(height: 24),
                        Center(
                          child: GestureDetector(
                            onTap: _how,
                            child: Text(
                              'How does this work?',
                              style:
                                  Type.body.copyWith(color: EvabobColors.blue),
                            ),
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
