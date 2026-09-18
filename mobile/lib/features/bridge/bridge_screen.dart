import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/config/app_features.dart';
import '../../core/notify/section_notify.dart';
import '../../core/utils/text_safe.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/utils/money_format.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/address_scan_sheet.dart';
import '../../core/widgets/asset_thumbnail.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';

/// Bridge USDC end-to-end via App Kit (bidirectional) or Arc CCTP fallback.
class BridgeScreen extends StatefulWidget {
  const BridgeScreen({super.key, this.onBack});

  final VoidCallback? onBack;

  @override
  State<BridgeScreen> createState() => _BridgeScreenState();
}

class _BridgeScreenState extends State<BridgeScreen> {
  final _amount = TextEditingController(text: '5');
  final _dest = TextEditingController();

  /// Product-supported CCTP / App Kit chains (same set as Swap-style pickers).
  static const _chains = <({int domain, String name, String appKit})>[
    (domain: 26, name: 'Arc Testnet', appKit: 'Arc_Testnet'),
    (domain: 6, name: 'Base Sepolia', appKit: 'Base_Sepolia'),
    (domain: 0, name: 'Ethereum Sepolia', appKit: 'Ethereum_Sepolia'),
  ];

  int _sourceDomain = 26;
  int _destDomain = 6;
  bool _busy = false;
  String _phase = 'idle';
  String? _phaseLabel;
  String? _burnTxHash;
  String? _mintTxHash;
  String? _lastError;
  int? _selectedPct;
  Timer? _quoteTimer;
  String? _expectedLine;
  String? _expectedToken;
  double? _expectedAmount;
  String? _routeNote;
  bool _bridgeable = true;

  static const _pcts = [10, 25, 50, 75, 100];
  static const _zeroAddr = '0x0000000000000000000000000000000000000000';

  /// Native Arc USDC is gas — never let 100% drain it.
  static const _arcUsdcGasReserve = 0.05;

  String _nameFor(int domain) => _chains
      .firstWhere(
        (c) => c.domain == domain,
        orElse: () => (domain: domain, name: 'Another network', appKit: ''),
      )
      .name;

  String get _sourceName => _nameFor(_sourceDomain);
  String get _destName => _nameFor(_destDomain);

  List<({int domain, String name, String appKit})> get _destOptions =>
      _chains.where((c) => c.domain != _sourceDomain).toList();

  List<({int domain, String name, String appKit})> get _sourceOptions =>
      _chains.where((c) => c.domain != _destDomain).toList();

  double _sourceBal(WalletService wallet) =>
      wallet.tokenOnSourceDomain(_sourceDomain, 'USDC');

  String _appKit(int domain) => _chains
      .firstWhere(
        (c) => c.domain == domain,
        orElse: () => (domain: domain, name: '', appKit: 'Arc_Testnet'),
      )
      .appKit;

  bool get _isArcUsdc => _sourceDomain == 26;

  double _spendable(WalletService wallet) {
    final raw = _sourceBal(wallet);
    if (_isArcUsdc) {
      return raw > _arcUsdcGasReserve ? raw - _arcUsdcGasReserve : 0;
    }
    return raw;
  }

  void _swapDirections() {
    if (_busy) return;
    setState(() {
      final s = _sourceDomain;
      _sourceDomain = _destDomain;
      _destDomain = s;
      // Keep dest valid after swap.
      if (_sourceDomain == _destDomain) {
        final alt = _chains.firstWhere((c) => c.domain != _sourceDomain);
        _destDomain = alt.domain;
      }
      _selectedPct = null;
    });
    _scheduleQuote();
  }

  void _onSourceChanged(int? v) {
    if (v == null || _busy) return;
    setState(() {
      _sourceDomain = v;
      if (_destDomain == _sourceDomain) {
        _destDomain = _destOptions.first.domain;
      }
      _selectedPct = null;
    });
    _scheduleQuote();
  }

  void _onDestChanged(int? v) {
    if (v == null || _busy) return;
    setState(() {
      _destDomain = v;
      if (_sourceDomain == _destDomain) {
        _sourceDomain = _sourceOptions.first.domain;
      }
      _selectedPct = null;
      final circle = context.read<CircleWalletService>();
      if (_dest.text.isNotEmpty && !_dest.text.startsWith('0x')) {
        _dest.text = circle.address ?? '';
      }
    });
    _scheduleQuote();
  }

  void _applyPct(int pct, WalletService wallet) {
    if (_busy) return;
    final avail = _spendable(wallet);
    if (avail <= 0) return;
    final v = avail * pct / 100;
    const d = 6;
    var text = v.toStringAsFixed(d).replaceFirst(RegExp(r'\.?0+$'), '');
    if (text.isEmpty || text == '.') {
      text = v.toStringAsFixed(d == 8 ? 6 : 2);
    }
    setState(() {
      _selectedPct = pct;
      _amount.text = text;
    });
    _scheduleQuote();
  }

  void _scheduleQuote() {
    _quoteTimer?.cancel();
    _quoteTimer = Timer(const Duration(milliseconds: 280), _refreshQuote);
  }

  Future<void> _refreshQuote() async {
    final amt = double.tryParse(_amount.text.trim());
    if (amt == null || amt <= 0) {
      if (!mounted) return;
      setState(() {
        _expectedLine = null;
        _expectedToken = null;
        _expectedAmount = null;
        _routeNote = null;
        _bridgeable = true;
      });
      return;
    }
    final wallet = context.read<WalletService>();
    try {
      final q = await wallet.quoteAppKitBridge(
        amount: amt,
        fromChain: _appKit(_sourceDomain),
        toChain: _appKit(_destDomain),
        token: 'USDC',
      );
      if (!mounted) return;
      final out = (q['amountOut'] as num?)?.toDouble();
      final tokenOut = q['tokenOut']?.toString() ?? 'USDC';
      final note = q['note']?.toString();
      final ok = q['ok'] == true && q['bridgeable'] != false;
      setState(() {
        _bridgeable = ok;
        _expectedAmount = out;
        _expectedToken = tokenOut;
        _routeNote = note;
        _expectedLine = out != null
            ? '~ ${formatTokenAmount(out, tokenOut)}'
            : (q['error']?.toString() ?? 'Quote unavailable');
      });
    } catch (e) {
      if (!mounted) return;
      final msg =
          e.toString().replaceFirst(RegExp(r'^ApiException\(\d+\):\s*'), '');
      setState(() {
        _bridgeable = false;
        _expectedAmount = null;
        _expectedToken = null;
        _routeNote = msg;
        _expectedLine = msg;
      });
    }
  }

  @override
  void initState() {
    super.initState();
    _amount.addListener(() {
      if (_busy) return;
      _scheduleQuote();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final circle = context.read<CircleWalletService>();
      final wallet = context.read<WalletService>();
      try {
        await circle.ensureReady(context);
        if (!mounted) return;
        await wallet.refreshBalances(
          addressOverride: circle.address,
          force: true,
          silent: true,
        );
        if (_dest.text.isEmpty) {
          _dest.text = circle.address ?? '';
        }
      } catch (_) {}
      if (mounted) {
        setState(() {});
        _scheduleQuote();
      }
    });
  }

  Future<void> _scanRecipient() async {
    final hit =
        await AddressScanSheet.open(context, title: 'Scan who receives it');
    if (!mounted || hit == null) return;
    setState(() {
      _dest.text = hit.address;
      if (hit.domain != null && hit.domain != _sourceDomain) {
        _destDomain = hit.domain!;
      }
    });
  }

  @override
  void dispose() {
    _quoteTimer?.cancel();
    _amount.dispose();
    _dest.dispose();
    super.dispose();
  }

  Future<void> _bridge() async {
    final raw = _amount.text.trim();
    if (!RegExp(r'^\d+(\.\d+)?$').hasMatch(raw)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Enter an amount like 12.50'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    final amt = double.tryParse(raw);
    final dest = _dest.text.trim();
    if (amt == null || amt <= 0 || dest.isEmpty || _busy) return;
    if (amt > 1000000) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Amount is too large'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    final evmOk = RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(dest) &&
        dest.toLowerCase() != _zeroAddr;
    if (!evmOk) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Enter a valid 0x address to receive it',
          ),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    if (_sourceDomain == _destDomain) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Pick different source and destination chains'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    if (!_bridgeable) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content:
              Text(_routeNote ?? 'This token cannot be bridged on this route'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }

    final circle = context.read<CircleWalletService>();
    final wallet = context.read<WalletService>();
    final available = _sourceBal(wallet);
    final spendable = _spendable(wallet);
    // The Evabob fee is added on top of the amount moved.
    final platformFee = context.read<AppFeatures>().platformFeeFor(amt);
    if (amt + platformFee > spendable + 1e-9) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            _isArcUsdc && amt + platformFee <= available + 1e-9
                ? 'Leave ${formatMoney(_arcUsdcGasReserve)} on Arc to cover the fee'
                : platformFee > 0 && amt <= spendable + 1e-9
                    ? 'Not enough for the amount plus the ${formatMoney(platformFee)} Evabob fee'
                    : 'Not enough on $_sourceName (${formatTokenAmount(available, 'USDC')})',
          ),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }

    // Moving money between networks is the slowest thing this app does and the
    // one most likely to look broken halfway through, so the wait is stated up
    // front rather than discovered.
    final confirmed = await confirmPayment(
      context,
      PaymentReview(
        payeeLabel: 'Moving to',
        payee: _destName,
        amount: amt,
        action: 'Move',
        // Circle takes a small Fast Transfer fee on the way; the quote
        // already subtracted it. Stale or missing quotes show the full amount.
        landedAmount: _expectedAmount != null && _expectedAmount! <= amt
            ? _expectedAmount
            : null,
        landedLabel: 'Arrives on $_destName',
        note: 'It leaves $_sourceName now and appears on $_destName once it '
            'settles. Your money is safe while it is on its way.',
      ),
    );
    if (!confirmed || !mounted) return;

    setState(() {
      _busy = true;
      _phase = 'pin';
      _phaseLabel = 'Confirm with your PIN…';
      _burnTxHash = null;
      _mintTxHash = null;
      _lastError = null;
    });

    try {
      final res = await circle.bridge(
        context: context,
        amountUsdc: amt,
        sourceDomain: _sourceDomain,
        destinationDomain: _destDomain,
        mintRecipient: dest,
        token: 'USDC',
        onStage: (stage, label) {
          if (!mounted) return;
          setState(() {
            _phase = stage;
            _phaseLabel = label;
          });
        },
      );
      if (!mounted) return;

      final burnHash = res['burnTxHash']?.toString();
      final mintHash = res['mintTx']?.toString();
      final stage = res['stage']?.toString() ?? '';
      final ok = res['ok'] == true;

      setState(() {
        if (burnHash != null && burnHash.startsWith('0x')) {
          _burnTxHash = burnHash;
        }
        if (mintHash != null && mintHash.startsWith('0x')) {
          _mintTxHash = mintHash;
        }
        _phase = stage.isNotEmpty ? stage : (ok ? 'minted' : 'error');
        _phaseLabel = res['error']?.toString() ??
            (ok
                ? 'Moved ${formatMoney(amt)} · $_sourceName → $_destName'
                : _phaseLabel ?? 'That did not finish.');
        if (!ok) {
          _lastError = res['error']?.toString() ??
              res['hint']?.toString() ??
              'Bridge incomplete';
        }
      });

      await wallet.refreshBalances(
        addressOverride: circle.address,
        force: true,
        silent: true,
      );
      if (!mounted) return;
      try {
        context.read<SectionNotify>().bump('activity');
      } catch (_) {}

      if (ok && (stage == 'minted' || stage == 'burned')) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              stage == 'minted'
                  ? 'Done · ${_expectedLine ?? '$amt'} is on $_destName'
                  : 'On the way to $_destName',
            ),
            behavior: SnackBarBehavior.floating,
          ),
        );
        if (stage == 'minted') {
          widget.onBack?.call();
        }
      } else if (burnHash != null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'It left $_sourceName but has not landed yet.\n'
              '${_lastError ?? "You can try again in a moment."}',
            ),
            behavior: SnackBarBehavior.floating,
            duration: const Duration(seconds: 6),
          ),
        );
      } else if (stage != 'cancelled') {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(_lastError ?? 'Bridge failed'),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = 'error';
        _phaseLabel = friendlyError(e, fallback: 'That did not finish.');
        _lastError = friendlyError(e, fallback: 'That did not finish.');
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _retryMint() async {
    final hash = _burnTxHash;
    if (hash == null || _busy) return;
    setState(() {
      _busy = true;
      _phase = 'attesting';
      _phaseLabel = 'Trying again…';
      _lastError = null;
    });
    final circle = context.read<CircleWalletService>();
    try {
      final res = await circle.finishBridge(
        burnTxHash: hash,
        destinationDomain: _destDomain,
      );
      if (!mounted) return;
      final ok = res['ok'] == true;
      final mintHash = res['mintTx']?.toString();
      setState(() {
        if (mintHash != null && mintHash.startsWith('0x')) {
          _mintTxHash = mintHash;
        }
        _phase = res['stage']?.toString() ?? (ok ? 'minted' : 'error');
        _phaseLabel = ok
            ? 'Arrived on $_destName'
            : friendlyError(res['error'], fallback: 'Still arriving.');
        if (!ok) _lastError = res['error']?.toString();
      });
      if (ok) {
        try {
          context.read<SectionNotify>().bump('activity');
        } catch (_) {}
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Arrived on $_destName'),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = 'error';
        _lastError = e.toString();
        _phaseLabel = e.toString();
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _stepChip(String id, String label,
      {required bool active, required bool done}) {
    final color = done
        ? EvabobColors.emeraldDeep
        : active
            ? EvabobColors.navy
            : EvabobColors.chalk;
    return Expanded(
      child: Column(
        children: [
          Icon(
            done
                ? Icons.check_circle_rounded
                : active
                    ? Icons.radio_button_checked
                    : Icons.radio_button_unchecked,
            size: 18,
            color: color,
          ),
          const SizedBox(height: 4),
          Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 10,
              fontWeight: active || done ? FontWeight.w400 : FontWeight.w400,
              color: color,
            ),
          ),
        ],
      ),
    );
  }

  bool get _pinDone =>
      _phase != 'idle' &&
      _phase != 'pin' &&
      _phase != 'wallet' &&
      _phase != 'burn_request' &&
      _phase != 'cancelled';
  bool get _burnDone =>
      _burnTxHash != null ||
      _phase == 'burned' ||
      _phase == 'attesting' ||
      _phase == 'minted' ||
      _phase == 'mint_failed';
  bool get _mintDone => _phase == 'minted' && _mintTxHash != null;

  @override
  Widget build(BuildContext context) {
    final wallet = context.watch<WalletService>();
    final available = _sourceBal(wallet);

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: [
            EvabobPageHeader(
              title: 'Move money',
              onBack: _busy ? null : widget.onBack,
              trailing: _busy
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : null,
            ),
            const SizedBox(height: 8),
            Glass(
              heavy: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text(
                    'Source',
                    style: TextStyle(
                      fontWeight: FontWeight.w400,
                      color: EvabobColors.navy,
                    ),
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<int>(
                    // ignore: deprecated_member_use
                    value: _sourceDomain,
                    decoration: InputDecoration(
                      border: const OutlineInputBorder(),
                      isDense: true,
                      labelText: 'From',
                      helperText:
                          '${formatTokenAmount(available, 'USDC')} on $_sourceName',
                    ),
                    items: [
                      for (final c in _chains)
                        DropdownMenuItem(
                          value: c.domain,
                          enabled: c.domain != _destDomain,
                          child: Row(
                            children: [
                              AssetThumbnail(asset: c.name, size: 24),
                              const SizedBox(width: 10),
                              Text(
                                '${c.name}'
                                '${c.domain == _destDomain ? ' (destination)' : ''}',
                              ),
                            ],
                          ),
                        ),
                    ],
                    onChanged: _busy ? null : _onSourceChanged,
                  ),
                  const SizedBox(height: 8),
                  Center(
                    child: IconButton.filledTonal(
                      tooltip: 'Swap source and destination',
                      onPressed: _busy ? null : _swapDirections,
                      icon: const Icon(Icons.swap_vert_rounded),
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Text(
                    'Destination',
                    style: TextStyle(
                      fontWeight: FontWeight.w400,
                      color: EvabobColors.navy,
                    ),
                  ),
                  const SizedBox(height: 8),
                  DropdownButtonFormField<int>(
                    // ignore: deprecated_member_use
                    value: _destDomain,
                    decoration: InputDecoration(
                      border: const OutlineInputBorder(),
                      isDense: true,
                      labelText: 'To',
                      helperText: _expectedAmount != null
                          ? '~ ${formatTokenAmount(_expectedAmount!, _expectedToken ?? 'USDC')} on $_destName'
                          : _expectedLine ?? 'You receive it on $_destName',
                      helperMaxLines: 2,
                      helperStyle: TextStyle(
                        fontSize: 10,
                        color: _bridgeable
                            ? EvabobColors.navyMuted
                            : EvabobColors.danger,
                      ),
                    ),
                    items: [
                      for (final d in _chains)
                        DropdownMenuItem(
                          value: d.domain,
                          enabled: d.domain != _sourceDomain,
                          child: Row(
                            children: [
                              AssetThumbnail(asset: d.name, size: 24),
                              const SizedBox(width: 10),
                              Text(d.name),
                            ],
                          ),
                        ),
                    ],
                    onChanged: _busy ? null : _onDestChanged,
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _amount,
                    enabled: !_busy,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [
                      FilteringTextInputFormatter.allow(RegExp(r'[\d.]')),
                    ],
                    decoration: InputDecoration(
                      labelText: 'Amount',
                      border: const OutlineInputBorder(),
                      helperText:
                          'From $_sourceName · ${formatTokenAmount(available, 'USDC')}'
                          '${_isArcUsdc ? ' · leave ${formatMoney(_arcUsdcGasReserve)} for the fee' : ''}',
                      helperMaxLines: 2,
                    ),
                    onChanged: (_) {
                      if (_selectedPct != null) {
                        setState(() => _selectedPct = null);
                      }
                    },
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      for (final pct in _pcts) ...[
                        if (pct != _pcts.first) const SizedBox(width: 6),
                        Expanded(
                          child: PressScale(
                            onTap: _busy ? null : () => _applyPct(pct, wallet),
                            child: Container(
                              height: 44,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: _selectedPct == pct
                                    ? EvabobColors.emerald
                                        .withValues(alpha: 0.2)
                                    : EvabobColors.creamDeep,
                                borderRadius: BorderRadius.circular(999),
                                border: Border.all(
                                  color: _selectedPct == pct
                                      ? EvabobColors.emerald
                                          .withValues(alpha: 0.55)
                                      : EvabobColors.sand,
                                ),
                              ),
                              child: Text(
                                '$pct%',
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w400,
                                  color: _selectedPct == pct
                                      ? EvabobColors.emeraldDeep
                                      : EvabobColors.navy,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _dest,
                    enabled: !_busy,
                    decoration: InputDecoration(
                      labelText: 'Send it to this account instead',
                      border: const OutlineInputBorder(),
                      helperText: 'Defaults to your wallet on the destination',
                      suffixIcon: IconButton(
                        tooltip: 'Scan QR',
                        onPressed: _busy ? null : _scanRecipient,
                        icon: const Icon(Icons.qr_code_scanner_rounded),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  if (_phase != 'idle') ...[
                    Row(
                      children: [
                        _stepChip(
                          'pin',
                          'Confirm',
                          active: _phase == 'pin',
                          done: _pinDone,
                        ),
                        _stepChip(
                          'attest',
                          'Check',
                          active: _phase == 'resolving' ||
                              _phase == 'attesting' ||
                              _phase == 'burned',
                          done: _burnDone &&
                              (_phase == 'minted' ||
                                  _phase == 'mint_failed' ||
                                  _mintDone),
                        ),
                        _stepChip(
                          'mint',
                          'Arrive',
                          active: _phase == 'attesting',
                          done: _mintDone || _phase == 'minted',
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    if (_phaseLabel != null)
                      Text(
                        _phaseLabel!,
                        style: TextStyle(
                          fontSize: 10,
                          color: _lastError != null && !_mintDone
                              ? EvabobColors.danger
                              : EvabobColors.navyMuted,
                        ),
                      ),
                    if (_burnTxHash != null) ...[
                      const SizedBox(height: 8),
                      _HashRow(label: 'Sent', hash: _burnTxHash!),
                    ],
                    if (_mintTxHash != null) ...[
                      const SizedBox(height: 4),
                      _HashRow(label: 'Arrived', hash: _mintTxHash!),
                    ],
                    if (_burnTxHash != null &&
                        !_mintDone &&
                        _phase != 'pin' &&
                        !_busy) ...[
                      const SizedBox(height: 10),
                      OutlinedButton(
                        onPressed: _retryMint,
                        child: const Text('Try the last step again'),
                      ),
                    ],
                    const SizedBox(height: 12),
                  ],
                  FilledButton(
                    onPressed: _busy || !_bridgeable ? null : _bridge,
                    child: Text(
                      _busy
                          ? (_phaseLabel ?? 'Working…')
                          : 'Move ${formatMoney(double.tryParse(_amount.text.trim()) ?? 0)} · $_sourceName → $_destName',
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _routeNote ??
                        'Only dollars can move between networks. The same amount arrives on the other side.',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 10,
                      color: EvabobColors.chalk,
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

class _HashRow extends StatelessWidget {
  const _HashRow({required this.label, required this.hash});

  final String label;
  final String hash;

  @override
  Widget build(BuildContext context) {
    final short = hash.length > 14
        ? '${hash.substring(0, 8)}…${hash.substring(hash.length - 6)}'
        : hash;
    return Row(
      children: [
        Text(
          '$label ',
          style: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w400,
            color: EvabobColors.navyMuted,
          ),
        ),
        Expanded(
          child: Text(
            short,
            style: const TextStyle(
              fontSize: 10,
              fontFamily: 'monospace',
              color: EvabobColors.navy,
            ),
          ),
        ),
        IconButton(
          visualDensity: VisualDensity.compact,
          padding: EdgeInsets.zero,
          constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
          onPressed: () {
            Clipboard.setData(ClipboardData(text: hash));
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text('$label hash copied'),
                behavior: SnackBarBehavior.floating,
                duration: const Duration(seconds: 1),
              ),
            );
          },
          icon: const Icon(Icons.copy_rounded, size: 16),
        ),
      ],
    );
  }
}
