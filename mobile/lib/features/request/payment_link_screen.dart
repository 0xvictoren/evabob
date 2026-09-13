import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_theme.dart';
import '../../core/utils/money_format.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';

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

  @override
  Widget build(BuildContext context) {
    final invoice = _invoice;
    final amount = (invoice?['total'] as num?)?.toDouble() ??
        (invoice?['amount'] as num?)?.toDouble() ??
        0;
    final token = invoice?['token']?.toString() == 'EURC' ? 'EURC' : 'USDC';
    final status = invoice?['status']?.toString() ?? '';
    final open = status == 'open';
    final payee = invoice?['payee'] is Map
        ? Map<String, dynamic>.from(invoice!['payee'] as Map)
        : <String, dynamic>{};

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: EvabobPageHeader(
                  title: 'Payment request', onBack: widget.onBack),
            ),
            Expanded(
              child: _busy && invoice == null
                  ? const Center(
                      child:
                          CircularProgressIndicator(color: EvabobColors.blue))
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
                      children: [
                        Text(
                          amount > 0
                              ? formatMoney(amount, token)
                              : 'Request unavailable',
                          textAlign: TextAlign.center,
                          style: EvabobTheme.amountDisplay,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          open
                              ? '${payee['label'] ?? 'Someone'} requested money'
                              : status.isEmpty
                                  ? 'We could not load this request'
                                  : 'This request is $status',
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              fontSize: 14, color: EvabobColors.navyMuted),
                        ),
                        const SizedBox(height: 24),
                        if (invoice != null)
                          Glass(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (final raw
                                    in (invoice['items'] as List? ?? const []))
                                  if (raw is Map)
                                    Padding(
                                      padding: const EdgeInsets.symmetric(
                                          vertical: 6),
                                      child: Row(
                                        children: [
                                          Expanded(
                                              child: Text(raw['description']
                                                      ?.toString() ??
                                                  'Item')),
                                          Text(formatMoney(
                                              (raw['amount'] as num?)
                                                      ?.toDouble() ??
                                                  0,
                                              token)),
                                        ],
                                      ),
                                    ),
                                if ((invoice['note']?.toString() ?? '')
                                    .isNotEmpty) ...[
                                  const Divider(),
                                  Text(
                                    invoice['note'].toString(),
                                    style: const TextStyle(
                                        fontSize: 10,
                                        color: EvabobColors.navyMuted),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        if (_error != null) ...[
                          const SizedBox(height: 16),
                          Text(_error!,
                              textAlign: TextAlign.center,
                              style:
                                  const TextStyle(color: EvabobColors.alert)),
                        ],
                        const SizedBox(height: 24),
                        EvabobPrimaryButton(
                          label: open
                              ? 'Pay ${formatMoney(amount, token)}'
                              : 'Request $status',
                          onPressed: open && !_busy ? _pay : null,
                          busy: _busy,
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

class _ClaimLinkScreenState extends State<ClaimLinkScreen> {
  Map<String, dynamic>? _claim;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await context.read<WalletService>().syncSession();
      await _load();
    });
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

  @override
  Widget build(BuildContext context) {
    final amount = (_claim?['amount'] as num?)?.toDouble() ?? 0;
    final status = _claim?['status']?.toString() ?? '';
    final pending = status == 'pending' && _claim?['expired'] != true;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child:
                  EvabobPageHeader(title: 'Claim money', onBack: widget.onBack),
            ),
            Expanded(
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Glass(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(amount > 0 ? formatMoney(amount) : 'Held payment',
                            style: EvabobTheme.amountDisplay),
                        const SizedBox(height: 12),
                        Text(
                          pending
                              ? 'Your verified account is being linked. Evabob releases only to your wallet.'
                              : status == 'claimed'
                                  ? 'This money has been claimed.'
                                  : status == 'refunded' ||
                                          _claim?['expired'] == true
                                      ? 'The claim window ended and the money was returned.'
                                      : (_error ?? 'Checking this payment…'),
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              fontSize: 12, color: EvabobColors.navyMuted),
                        ),
                        const SizedBox(height: 20),
                        EvabobPrimaryButton(
                          label: pending ? 'Check claim status' : 'Refresh',
                          onPressed: _busy ? null : _load,
                          busy: _busy,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
