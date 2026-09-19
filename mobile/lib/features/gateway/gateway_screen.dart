// Top-up · Pay — Circle Gateway unified USDC balance.
//
// Gateway keeps per-chain deposits and presents them as one balance. Top-up
// runs approve + deposit() to move chain USDC into it; Pay signs a burn intent
// that can draw across several chains at once and mints at the destination.
// Supported source chains: Arc Testnet, Ethereum Sepolia, Base Sepolia.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/config/app_features.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/utils/text_safe.dart';
import '../../core/utils/money_format.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/asset_thumbnail.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/address_scan_sheet.dart';
import '../../core/widgets/glass.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import 'package:evabob_mobile/core/utils/amount_input.dart';

class GatewayScreen extends StatefulWidget {
  const GatewayScreen({
    super.key,
    this.onBack,
    this.mode = GatewayMode.topUp,
  });

  final VoidCallback? onBack;
  final GatewayMode mode;

  @override
  State<GatewayScreen> createState() => _GatewayScreenState();
}

enum GatewayMode {
  /// Move chain wallet USDC into the Gateway unified balance (approve + deposit)
  topUp,

  /// Pay / spend from the unified balance to any domain
  pay,
}

class _GatewayScreenState extends State<GatewayScreen> {
  late GatewayMode _mode;
  final _amount = TextEditingController(text: '5');
  final _dest = TextEditingController();
  int _domain = 26; // Arc default for pay
  bool _busy = false;

  /// Source chain for Gateway top-up / deposit address context.
  String _sourceChain = 'Arc_Testnet';

  static const _sourceChains = <({String id, String name, int domain})>[
    (id: 'Arc_Testnet', name: 'Arc Testnet', domain: 26),
    (id: 'Ethereum_Sepolia', name: 'Ethereum Sepolia', domain: 0),
    (id: 'Base_Sepolia', name: 'Base Sepolia', domain: 6),
  ];

  static const _payDomains = <({int domain, String name})>[
    (domain: 26, name: 'Arc Testnet'),
    (domain: 0, name: 'Ethereum Sepolia'),
    (domain: 6, name: 'Base Sepolia'),
  ];

  String get _sourceChainName =>
      _sourceChains
          .where((c) => c.id == _sourceChain)
          .map((c) => c.name)
          .firstOrNull ??
      _sourceChain;

  int get _sourceDomain =>
      _sourceChains
          .where((c) => c.id == _sourceChain)
          .map((c) => c.domain)
          .firstOrNull ??
      26;

  @override
  void initState() {
    super.initState();
    _mode = widget.mode;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final circle = context.read<CircleWalletService>();
      final wallet = context.read<WalletService>();
      try {
        await circle.ensureReady(context);
        if (!mounted) return;
        await wallet.refreshBalances(addressOverride: circle.address);
        await wallet.loadDepositAddresses();
        if (circle.address != null && _dest.text.isEmpty) {
          _dest.text = circle.address!;
        }
      } catch (_) {}
      if (mounted) setState(() {});
    });
  }

  Future<void> _scanPayee() async {
    final hit = await AddressScanSheet.open(context, title: 'Scan payee');
    if (!mounted || hit == null) return;
    setState(() {
      _dest.text = hit.address;
      if (hit.domain != null) {
        _domain = hit.domain!;
      }
    });
  }

  @override
  void dispose() {
    _amount.dispose();
    _dest.dispose();
    super.dispose();
  }

  double _walletUsdcOnSource(WalletService wallet) {
    // Prefer per-domain Gateway deposit balance; fall back to Arc wallet for Arc.
    final onDomain = wallet.usdcOnDomain(_sourceDomain);
    if (_sourceDomain == 26) {
      // Arc: show spendable Arc wallet USDC for top-up (not just gateway residual)
      return wallet.usdcWallet;
    }
    // Other chains: domain gateway balance or chain balance if available
    if (onDomain > 0) return onDomain;
    for (final row in wallet.chainBalances) {
      final id = row['id']?.toString().toLowerCase() ?? '';
      final name = row['name']?.toString().toLowerCase() ?? '';
      final match = _sourceChain.toLowerCase().contains('eth')
          ? (id.contains('eth') || name.contains('ethereum'))
          : _sourceChain.toLowerCase().contains('base')
              ? (id.contains('base') || name.contains('base'))
              : false;
      if (match) {
        final u = (row['usdc'] as num?)?.toDouble();
        if (u != null) return u;
      }
    }
    return onDomain;
  }

  /// What to tell someone whose deposit has not shown up yet.
  ///
  /// Measured on testnet, not estimated:
  ///   Arc              credited in under 5 seconds
  ///   Base Sepolia     deposit mined promptly, credited after ~42 minutes
  ///   Ethereum Sepolia one deposit sat unmined for ~15 hours before landing
  ///
  /// Ethereum Sepolia in particular is slow enough that any wording implying
  /// minutes would be a lie. Being straight about it is the difference between
  /// "it's on its way" and "this app lost my money".
  String _settlementHint(int domain) {
    switch (domain) {
      case 26:
        return 'It should appear within a minute.';
      case 6:
        return 'This usually takes up to an hour. '
            'It will appear on its own — you can close the app.';
      case 0:
        return 'This one can take several hours. Your money is safe and will '
            'appear on its own. Move it from Arc instead if you need it sooner.';
      default:
        return 'It will appear on its own once it clears.';
    }
  }

  Future<void> _topUp() async {
    final amt = double.tryParse(_amount.text.trim());
    if (amt == null || amt <= 0 || _busy) return;
    final circle = context.read<CircleWalletService>();
    final wallet = context.read<WalletService>();
    final features = context.read<AppFeatures>();
    // The Evabob fee is added on top of the top-up.
    final platformFee = features.platformFeeFor(amt);
    if (_sourceDomain == 26 && amt + platformFee > wallet.usdcWallet + 1e-9) {
      showTopSnack(
        context,
        SnackBar(
          content: Text(
            platformFee > 0
                ? 'Not enough on Arc for ${formatUsdc(amt)} plus the '
                    '${formatUsdc(platformFee)} Evabob fee — you have '
                    '${formatUsdc(wallet.usdcWallet)}'
                : 'Not enough on Arc — you have ${formatUsdc(wallet.usdcWallet)}',
          ),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    // Topping up keeps the money yours, so this does not claim to be
    // irreversible — but off Arc it can take hours, which is worth knowing
    // before starting rather than during. With the fee on, the approval,
    // deposit and fee are one batched confirmation.
    final confirmed = await confirmPayment(
      context,
      PaymentReview(
        payeeLabel: 'Moving from',
        payee: _sourceChainName,
        amount: amt,
        action: 'Top up',
        landedLabel: 'Arrives in your GA',
        warning: features.platformFeeBps > 0
            ? 'The money stays yours the whole time. You will be asked to '
                'confirm once.'
            : 'The money stays yours the whole time. You will be asked to '
                'confirm twice.',
        note: _settlementHint(_sourceDomain),
      ),
    );
    if (!confirmed || !mounted) return;

    setState(() => _busy = true);
    try {
      final prevGw = wallet.gatewayUsdc;
      final ok = await circle.gatewayDeposit(
        context: context,
        amountUsdc: amt,
        chain: _sourceChain,
      );
      if (!mounted) return;
      if (ok) {
        // Real deposit() via App Kit — poll pending+confirmed until credit shows.
        final watch = await wallet.pollUnifiedBalanceAfterDeposit(
          addressOverride: circle.address,
          previousGatewayUsdc: prevGw,
        );
        if (!mounted) return;
        // Gateway only credits once the deposit is final on its source chain:
        // seconds on Arc, but a measured Base Sepolia deposit took ~42 minutes.
        // Saying "topped up" while the balance has not moved is what made a
        // working deposit look broken, so each outcome gets its own message.
        final message = switch (watch) {
          DepositWatch.credited => 'Added ${formatUsdc(amt)} to your GA',
          DepositWatch.pending =>
            'On its way · ${formatUsdc(wallet.gatewayPendingUsdc)} arriving',
          DepositWatch.stillSettling =>
            '${formatUsdc(amt)} on its way. ${_settlementHint(_sourceDomain)}',
        };
        showTopSnack(
          context,
          SnackBar(
            content: Text(message),
            behavior: SnackBarBehavior.floating,
            duration: watch == DepositWatch.credited
                ? const Duration(seconds: 4)
                : const Duration(seconds: 8),
          ),
        );
      } else {
        showTopSnack(
          context,
          SnackBar(
            // circle.status is an internal progress/debug string — it says
            // things like "Challenge FAILED" and "Burn may have succeeded".
            // It was being shown here as the explanation.
            content: Text(
              'Could not move it from $_sourceChainName. Check your balance, '
              'then try again.',
            ),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pay() async {
    final amt = double.tryParse(_amount.text.trim());
    final dest = _dest.text.trim();
    if (amt == null || amt <= 0 || dest.isEmpty || _busy) return;
    final evmOk = RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(dest);
    if (!evmOk) {
      showTopSnack(
        context,
        const SnackBar(
          content: Text('Enter a valid 0x payee address'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    final wallet = context.read<WalletService>();
    final circle = context.read<CircleWalletService>();
    final spendable = wallet.gatewayConfirmedUsdc > 0
        ? wallet.gatewayConfirmedUsdc
        : wallet.gatewayUsdc;
    final need = amt + context.read<AppFeatures>().platformFeeFor(amt);
    if (need > spendable + 1e-9) {
      showTopSnack(
        context,
        SnackBar(
          content: Text(
            'Your GA has ${formatUsdc(spendable)} ready — you need '
            '${formatUsdc(need)} including the Evabob fee. Money still '
            'arriving cannot be spent yet.',
          ),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    // Paying an address straight from the pooled balance: no name to resolve,
    // so the address is the payee and always earns the extra tick.
    final confirmed = await confirmPayment(
      context,
      PaymentReview(
        payee: dest.length > 16
            ? '${dest.substring(0, 8)}…${dest.substring(dest.length - 6)}'
            : dest,
        payeeDetail: dest,
        amount: amt,
        firstTime: true,
      ),
    );
    if (!confirmed || !mounted) return;

    setState(() => _busy = true);
    try {
      final res = await circle.gatewayPay(
        context: context,
        amountUsdc: amt,
        destinationDomain: _domain,
        destinationAddress: dest,
      );
      if (!mounted) return;
      await wallet.refreshBalances(addressOverride: circle.address);
      if (!mounted) return;
      final ok = res['ok'] == true;
      final status = res['status']?.toString() ?? (ok ? 'submitted' : 'failed');
      final inTransit = res['doNotRetry'] == true &&
          (status == 'in_transit' ||
              status == 'forwarded' ||
              status == 'attestation_pending' ||
              // Waiting for a first-time approval to be final: it goes by itself.
              status == 'scheduled');
      final err = res['error']?.toString();
      final sources = res['sources'];
      String sourceNote = '';
      if (sources is List && sources.isNotEmpty) {
        sourceNote = sources
            .map((s) {
              if (s is! Map) return '';
              final m = Map<String, dynamic>.from(s);
              return '${m['amountUsdc'] ?? ''} ${m['name'] ?? m['domain'] ?? ''}';
            })
            .where((s) => s.trim().isNotEmpty)
            .join(' + ');
        if (sourceNote.isNotEmpty) sourceNote = ' · $sourceNote';
      }
      showTopSnack(
        context,
        SnackBar(
          content: Text(
            ok
                ? 'Paid ${formatUsdc(amt)} from your GA'
                : inTransit
                    ? (err ??
                        'Sent — it is on its way. No need to send it again.')
                    : friendlyError(err, fallback: 'Payment failed'),
          ),
          behavior: SnackBarBehavior.floating,
          duration: Duration(seconds: status == 'scheduled' ? 10 : 4),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      showTopSnack(
        context,
        SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _sourceChainPicker({required String label}) {
    return DropdownButtonFormField<String>(
      initialValue: _sourceChain,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      items: [
        for (final c in _sourceChains)
          DropdownMenuItem(
            value: c.id,
            child: Row(
              children: [
                AssetThumbnail(asset: c.name, size: 24),
                const SizedBox(width: 10),
                Text(c.name),
              ],
            ),
          ),
      ],
      onChanged: (v) {
        if (v == null) return;
        setState(() => _sourceChain = v);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final wallet = context.watch<WalletService>();
    final circle = context.watch<CircleWalletService>();
    final depositAddr = circle.address ?? wallet.address ?? '';
    final sourceBal = _walletUsdcOnSource(wallet);

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          children: [
            EvabobPageHeader(
              title: 'Gateway Account',
              onBack: widget.onBack,
            ),
            const SizedBox(height: 8),
            Glass(
              heavy: true,
              color: EvabobColors.blue,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Gateway Account',
                    style:
                        TextStyle(color: EvabobColors.lightDark, fontSize: 10),
                  ),
                  // The one invented term the app keeps, so it gets defined
                  // where it is used rather than in a help page nobody opens.
                  const Text(
                    'Money you have moved here, ready to spend anywhere.',
                    style:
                        TextStyle(color: EvabobColors.lightDark, fontSize: 10),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    formatUsdc(wallet.gatewayUsdc),
                    style: const TextStyle(
                      fontSize: 48,
                      fontWeight: FontWeight.w400,
                      color: EvabobColors.white,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Ready to spend  ${formatUsdc(wallet.gatewayConfirmedUsdc)}',
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w400,
                      color: EvabobColors.white,
                    ),
                  ),
                  Text(
                    'Still arriving  ${formatUsdc(wallet.gatewayPendingUsdc)}',
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w400,
                      color: EvabobColors.lightDark,
                    ),
                  ),
                  Text(
                    // Dollars only: the GA holds USDC, and euros are never
                    // shown beside a dollar total.
                    'Wallet ${formatUsdc(wallet.usdcWallet)} · '
                    'Total ${formatUsdc(wallet.totalUsdc)}',
                    style: const TextStyle(
                        fontSize: 10, color: EvabobColors.lightDark),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    'Where it came from',
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w400,
                      color: EvabobColors.lightDark,
                    ),
                  ),
                  const SizedBox(height: 6),
                  for (final c in _sourceChains)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              c.name,
                              style: const TextStyle(
                                fontSize: 11,
                                color: EvabobColors.white,
                              ),
                            ),
                          ),
                          Text(
                            formatUsdc(wallet.usdcOnDomain(c.domain)),
                            style: const TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w400,
                              fontFamily: 'monospace',
                              color: EvabobColors.white,
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (wallet.gatewayBalances.isNotEmpty)
                    for (final b in wallet.gatewayBalances)
                      if (!_sourceChains.any((c) => c.domain == b.domain) &&
                          b.balanceUsdc > 0)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  b.name ?? 'Another network',
                                  style: const TextStyle(
                                    fontSize: 10,
                                    color: EvabobColors.navy,
                                  ),
                                ),
                              ),
                              Text(
                                formatUsdc(b.balanceUsdc),
                                style: const TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w400,
                                  fontFamily: 'monospace',
                                  color: EvabobColors.emeraldDeep,
                                ),
                              ),
                            ],
                          ),
                        ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            // "Deposit" used to sit here. It only displayed a receive address
            // and did NOT credit the unified balance, which is the source of
            // the "Gateway balance 0 after transfer" confusion: the balance
            // only moves after Top-up runs approve + deposit(). The address is
            // still available on the Receive screen.
            SegmentedButton<GatewayMode>(
              segments: const [
                ButtonSegment(
                  value: GatewayMode.topUp,
                  label: Text('Top-up'),
                  icon: Icon(Icons.add_card_rounded, size: 16),
                ),
                ButtonSegment(
                  value: GatewayMode.pay,
                  label: Text('Pay'),
                  icon: Icon(Icons.payments_outlined, size: 16),
                ),
              ],
              selected: {_mode},
              onSelectionChanged: (s) => setState(() => _mode = s.first),
            ),
            const SizedBox(height: 14),
            if (_mode == GatewayMode.topUp) ...[
              Glass(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Top up your GA',
                      style: TextStyle(
                        fontWeight: FontWeight.w400,
                        color: EvabobColors.navy,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Move money you hold on another network into the '
                      'balance you spend from. You confirm with your PIN, and '
                      'we tell you when it has arrived.',
                      style: const TextStyle(
                        color: EvabobColors.navyMuted,
                        fontSize: 10,
                        height: 1.35,
                      ),
                    ),
                    const SizedBox(height: 12),
                    _sourceChainPicker(label: 'Move it from'),
                    const SizedBox(height: 8),
                    Text(
                      'You have ${formatUsdc(sourceBal)} there'
                      '${_sourceDomain == 26 ? ' (Arc wallet)' : ''}',
                      style: const TextStyle(
                        fontSize: 10,
                        color: EvabobColors.navyMuted,
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _amount,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      inputFormatters: const [AmountInputFormatter()],
                      decoration: const InputDecoration(
                        labelText: 'Amount',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 10),
                    FilledButton(
                      onPressed: depositAddr.isEmpty || _busy ? null : _topUp,
                      child: Text(
                        _busy ? 'Confirming…' : 'Top-up from $_sourceChainName',
                      ),
                    ),
                  ],
                ),
              ),
            ] else ...[
              Glass(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Pay from your GA',
                      style: TextStyle(
                        fontWeight: FontWeight.w400,
                        color: EvabobColors.navy,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'You have ${formatUsdc(wallet.gatewayConfirmedUsdc > 0 ? wallet.gatewayConfirmedUsdc : wallet.gatewayUsdc)} '
                      'ready to spend, anywhere Evabob reaches. It works out '
                      'where to take it from, so you do not have to pick. The '
                      'first payment to a new network asks you to confirm once '
                      'more. Money still arriving cannot be spent yet.',
                      style: const TextStyle(
                        color: EvabobColors.navyMuted,
                        fontSize: 10,
                        height: 1.35,
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _amount,
                      keyboardType: const TextInputType.numberWithOptions(
                        decimal: true,
                      ),
                      inputFormatters: const [AmountInputFormatter()],
                      decoration: const InputDecoration(
                        labelText: 'Amount',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 10),
                    DropdownButtonFormField<int>(
                      initialValue: _domain,
                      decoration: const InputDecoration(
                        labelText: 'Destination network',
                        border: OutlineInputBorder(),
                      ),
                      items: [
                        for (final d in _payDomains)
                          DropdownMenuItem(
                            value: d.domain,
                            child: Row(
                              children: [
                                AssetThumbnail(asset: d.name, size: 24),
                                const SizedBox(width: 10),
                                Text(d.name),
                              ],
                            ),
                          ),
                      ],
                      onChanged: (v) {
                        final next = v ?? 26;
                        setState(() {
                          _domain = next;
                          final circle = context.read<CircleWalletService>();
                          if (_dest.text.isNotEmpty &&
                              !_dest.text.startsWith('0x')) {
                            _dest.text = circle.address ?? '';
                          }
                        });
                      },
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _dest,
                      decoration: InputDecoration(
                        labelText: 'Payee 0x address',
                        border: const OutlineInputBorder(),
                        suffixIcon: IconButton(
                          tooltip: 'Scan QR',
                          onPressed: _busy ? null : _scanPayee,
                          icon: const Icon(Icons.qr_code_scanner_rounded),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    FilledButton(
                      onPressed: _busy ? null : _pay,
                      child: Text(_busy ? 'Submitting…' : 'Pay'),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
