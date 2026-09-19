import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:provider/provider.dart';

import '../../core/config/app_features.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/widgets/confirm_payment_sheet.dart';
import '../../core/widgets/asset_thumbnail.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/theme/evabob_theme.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/glass.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// Buy / swap on Arc: USDC · EURC · cirBTC · custom CA via Synthra + UCW PIN.
/// Simple amount field + % chips (no calculator — calculator is send-only).
class ExchangeScreen extends StatefulWidget {
  const ExchangeScreen({super.key, this.onBack, this.title = 'Convert'});

  final VoidCallback? onBack;
  final String title;

  @override
  State<ExchangeScreen> createState() => _ExchangeScreenState();
}

class _ExchangeScreenState extends State<ExchangeScreen> {
  /// Preset key or 'CUSTOM'
  String _fromPreset = 'USDC';
  String _toPreset = 'EURC';
  final _fromCa = TextEditingController();
  final _toCa = TextEditingController();
  final _fromDec = TextEditingController(text: '18');
  final _toDec = TextEditingController(text: '18');
  final _amountCtrl = TextEditingController();
  double _swapTurns = 0;
  bool _busy = false;
  String? _quoteLine;
  double? _quotedOut;
  int? _selectedPct;

  double? get _amountValue => double.tryParse(_amountCtrl.text.trim());

  static const _presets = ['USDC', 'EURC', 'CIRBTC', 'CUSTOM'];

  String get _fromToken {
    if (_fromPreset == 'CUSTOM') {
      final ca = _fromCa.text.trim();
      return ca.isEmpty ? 'USDC' : ca;
    }
    return _fromPreset;
  }

  String get _toToken {
    if (_toPreset == 'CUSTOM') {
      final ca = _toCa.text.trim();
      return ca.isEmpty ? 'EURC' : ca;
    }
    return _toPreset;
  }

  double _available(WalletService wallet, String token) {
    final t = token.toUpperCase();
    if (t == 'EURC') return wallet.eurcWallet;
    if (t == 'CIRBTC') return wallet.cirbtcWallet;
    if (t == 'USDC') return wallet.usdcWallet;
    // Custom CA: show 0 until we track holdings (still allow sell if user has it)
    return 0;
  }

  int? _decFrom() {
    if (_fromPreset == 'CUSTOM') return int.tryParse(_fromDec.text);
    if (_fromPreset == 'CIRBTC') return 8;
    return 6;
  }

  int? _decTo() {
    if (_toPreset == 'CUSTOM') return int.tryParse(_toDec.text);
    if (_toPreset == 'CIRBTC') return 8;
    return 6;
  }

  String _label(String preset, TextEditingController ca) {
    if (preset == 'CUSTOM') {
      final t = ca.text.trim();
      if (t.length >= 10) {
        return '${t.substring(0, 6)}…${t.substring(t.length - 4)}';
      }
      return 'Custom CA';
    }
    // Plain names, not tickers: this feeds the quote line, the insufficient
    // balance message and the confirmation sheet.
    return switch (preset) {
      'USDC' => 'dollars',
      'EURC' => 'euros',
      'CIRBTC' => 'bitcoin',
      _ => preset,
    };
  }

  void _setPct(int pct, WalletService wallet) {
    final avail = _available(wallet, _fromToken);
    if (avail <= 0) return;
    final v = avail * pct / 100;
    final decimals = _fromPreset == 'CIRBTC' ? 8 : 6;
    setState(() {
      _selectedPct = pct;
      _amountCtrl.text =
          v.toStringAsFixed(decimals).replaceFirst(RegExp(r'\.?0+$'), '');
      if (_amountCtrl.text.isEmpty || _amountCtrl.text == '.') {
        _amountCtrl.text = v.toStringAsFixed(decimals == 8 ? 6 : 2);
      }
    });
    _refreshQuote();
  }

  Future<void> _refreshQuote() async {
    final amount = _amountValue ?? 0;
    final from = _fromToken;
    final to = _toToken;
    if (amount <= 0 || from.toLowerCase() == to.toLowerCase()) {
      setState(() {
        _quoteLine = null;
        _quotedOut = null;
      });
      return;
    }
    if (_fromPreset == 'CUSTOM' &&
        !RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(from)) {
      setState(() {
        _quoteLine = 'Paste a valid 0x contract for spend token';
        _quotedOut = null;
      });
      return;
    }
    if (_toPreset == 'CUSTOM' && !RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(to)) {
      setState(() {
        _quoteLine = 'Paste a valid 0x contract for receive token';
        _quotedOut = null;
      });
      return;
    }
    final wallet = context.read<WalletService>();
    try {
      final q = await wallet.quoteExchange(
        from: from,
        to: to,
        amountIn: amount,
        fromDecimals: _decFrom(),
        toDecimals: _decTo(),
      );
      final out = (q['amountOut'] as num?)?.toDouble();
      if (!mounted) return;
      setState(() {
        _quotedOut = out;
        // Only the fee: where the rate comes from is not the person's concern.
        _quoteLine = out != null ? _feeLine(amount) : _noRate;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _quotedOut = null;
        _quoteLine = _plain(friendlyError(e, fallback: _noRate));
      });
    }
  }

  Future<void> _executeBuy() async {
    final amountIn = _amountValue ?? 0;
    final from = _fromToken;
    final to = _toToken;
    if (amountIn <= 0 || _busy || from.toLowerCase() == to.toLowerCase()) {
      return;
    }
    if (_fromPreset == 'CUSTOM' &&
        !RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(from)) {
      showTopSnack(
        context,
        const SnackBar(
          content: Text('Paste a valid spend token contract (0x…)'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    if (_toPreset == 'CUSTOM' && !RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(to)) {
      showTopSnack(
        context,
        const SnackBar(
          content: Text('Paste a valid receive token contract (0x…)'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }

    final wallet = context.read<WalletService>();
    final circle = context.read<CircleWalletService>();
    final avail = _available(wallet, from);
    // Only enforce balance for known treasury tokens
    if (['USDC', 'EURC', 'CIRBTC'].contains(from.toUpperCase()) &&
        amountIn > avail + 1e-9) {
      showTopSnack(
        context,
        SnackBar(
          content: Text(
            'Insufficient ${_label(_fromPreset, _fromCa)} '
            '(have ${avail.toStringAsFixed(_fromPreset == 'CIRBTC' ? 6 : 2)})',
          ),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }

    // Converting ends at the same PIN screen as everything else, which shows
    // nothing about the money. A swap has one extra thing worth saying: the
    // rate is a quote, not a promise.
    final confirmed = await confirmPayment(
      context,
      PaymentReview(
        payeeLabel: 'You receive',
        payee: _label(_toPreset, _toCa),
        amount: amountIn,
        token: _fromPreset == 'CUSTOM' ? 'USDC' : _fromPreset,
        action: 'Convert',
        warning: PaymentReview.rateMayMove,
        // App Kit takes a conversion fee out of the swap itself.
        feeOnTop: false,
        tokenDecimals: _fromPreset == 'CIRBTC' ? 8 : 6,
        note: _quotedOut == null
            ? null
            : 'About ${_quotedOut!.toStringAsFixed(_toPreset == 'CIRBTC' ? 6 : 2)} '
                '${_label(_toPreset, _toCa)} at the current rate.',
      ),
    );
    if (!confirmed || !mounted) return;

    setState(() => _busy = true);
    try {
      // Fresh quote right before PIN so route/amountOut is not stale.
      try {
        final q = await wallet.quoteExchange(
          from: from,
          to: to,
          amountIn: amountIn,
          fromDecimals: _decFrom(),
          toDecimals: _decTo(),
        );
        if (!mounted) return;
        final out = (q['amountOut'] as num?)?.toDouble();
        final err = q['error']?.toString();
        if (out == null || out <= 0) {
          final said = _plain(err != null && err.isNotEmpty
              ? friendlyError(err, fallback: _noRate)
              : _noRate);
          setState(() {
            _quotedOut = null;
            _quoteLine = said;
          });
          showTopSnack(
            context,
            SnackBar(
              content: Text(shortUiText(said, max: 160)),
              behavior: SnackBarBehavior.floating,
            ),
          );
          return;
        }
        setState(() {
          _quotedOut = out;
          _quoteLine = _feeLine(amountIn);
        });
      } catch (e) {
        if (!mounted) return;
        showTopSnack(
          context,
          SnackBar(
            content: Text(
                friendlyError(e, fallback: 'Could not get a rate just now.')),
            behavior: SnackBarBehavior.floating,
          ),
        );
        return;
      }

      final res = await circle.swap(
        context: context,
        from: from,
        to: to,
        amountIn: amountIn,
        fromDecimals: _decFrom(),
        toDecimals: _decTo(),
      );
      if (!mounted) return;
      if (res['ok'] == true) {
        // Allow Arc indexing to catch up before balance refresh.
        await Future<void>.delayed(const Duration(milliseconds: 1200));
        if (!mounted) return;
        await wallet.refreshBalances(addressOverride: circle.address);
        if (!mounted) return;
        final outHint = _quotedOut != null
            ? ' ≈ ${_quotedOut!.toStringAsFixed(_dp(_toPreset))} ${_label(_toPreset, _toCa)}'
            : '';
        await _showDone(
          context,
          '$amountIn ${_label(_fromPreset, _fromCa)} was converted to '
          '${_label(_toPreset, _toCa)}$outHint.',
        );
        if (!mounted) return;
        widget.onBack?.call();
      } else {
        final err = shortUiText(
          res['error']?.toString() ??
              res['hint']?.toString() ??
              'Swap cancelled — no receipt',
          max: 180,
        );
        setState(() {
          _quoteLine = err;
        });
        showTopSnack(
          context,
          SnackBar(
            content: Text(err),
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

  Widget _tokenPicker({
    required String label,
    required String preset,
    required ValueChanged<String> onPreset,
    required TextEditingController ca,
    required TextEditingController dec,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Type.label.copyWith(color: EvabobColors.navyMuted)),
        const SizedBox(height: 6),
        DropdownButtonFormField<String>(
          // ignore: deprecated_member_use
          value: preset,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            isDense: true,
          ),
          items: [
            for (final p in _presets)
              DropdownMenuItem(
                value: p,
                child: Row(
                  children: [
                    if (p == 'USDC' || p == 'EURC') ...[
                      AssetThumbnail(asset: p, size: 24),
                      const SizedBox(width: 10),
                    ] else ...[
                      const SizedBox.square(
                        dimension: 24,
                        child: Icon(Icons.currency_bitcoin, size: 20),
                      ),
                      const SizedBox(width: 10),
                    ],
                    Text(switch (p) {
                      'USDC' => 'Dollars',
                      'EURC' => 'Euros',
                      'CIRBTC' => 'Bitcoin',
                      _ => 'Another token',
                    }),
                  ],
                ),
              ),
          ],
          onChanged: (v) {
            if (v != null) onPreset(v);
          },
        ),
        if (preset == 'CUSTOM') ...[
          const SizedBox(height: 8),
          TextField(
            controller: ca,
            decoration: const InputDecoration(
              labelText: 'Paste the token address',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            style: const TextStyle(fontFamily: 'monospace', fontSize: 10),
            onChanged: (_) => _refreshQuote(),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: dec,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Decimal places (usually 18)',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            onChanged: (_) => _refreshQuote(),
          ),
        ],
      ],
    );
  }

  @override
  void dispose() {
    _fromCa.dispose();
    _toCa.dispose();
    _fromDec.dispose();
    _toDec.dispose();
    _amountCtrl.dispose();
    super.dispose();
  }

  static const _noRate = 'No rate for this pair right now. Try another amount.';

  /// Dollars and euros to the cent; Bitcoin needs more places.
  static int _dp(String preset) => preset == 'CIRBTC' ? 6 : 2;

  /// The fee, and nothing about where the rate comes from.
  String _feeLine(double amount) {
    final fee = context.read<AppFeatures>().platformFeeFor(amount);
    return 'Evabob fee ${formatMoney(fee, _fromPreset == 'EURC' ? 'EURC' : 'USDC')}';
  }

  /// Provider names are not for people.
  static String _plain(String text) =>
      RegExp('synthra', caseSensitive: false).hasMatch(text) ? _noRate : text;

  @override
  Widget build(BuildContext context) {
    final wallet = context.watch<WalletService>();
    final amount = _amountValue ?? 0.0;
    final canBuy = amount > 0 && !_busy;
    final avail = _available(wallet, _fromToken);
    final converted = _quotedOut ?? 0.0;

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: EvabobPageHeader(
                title: widget.title,
                onBack: widget.onBack,
                trailing: _busy
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : null,
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
                children: [
                  Glass(
                    child: Text(
                      'You have ${formatMoney(wallet.usdcWallet)} · '
                      '${formatMoney(wallet.eurcWallet, 'EURC')} · '
                      '${formatMoney(wallet.cirbtcWallet, 'CIRBTC')}',
                      style: const TextStyle(
                        color: EvabobColors.navyMuted,
                        fontSize: 10,
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Glass(
                    heavy: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _tokenPicker(
                          label: 'You spend',
                          preset: _fromPreset,
                          onPreset: (v) {
                            setState(() {
                              _fromPreset = v;
                              _quotedOut = null;
                              _quoteLine = null;
                            });
                            _refreshQuote();
                          },
                          ca: _fromCa,
                          dec: _fromDec,
                        ),
                        const SizedBox(height: 10),
                        TextField(
                          controller: _amountCtrl,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          inputFormatters: [
                            FilteringTextInputFormatter.allow(
                              RegExp(r'[\d.]'),
                            ),
                          ],
                          style:
                              EvabobTheme.amountDisplay.copyWith(fontSize: 48),
                          decoration: InputDecoration(
                            border: InputBorder.none,
                            hintText: '0',
                            suffixText: _label(_fromPreset, _fromCa),
                            suffixStyle: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w400,
                              color: EvabobColors.navyMuted,
                            ),
                          ),
                          onChanged: (_) {
                            setState(() => _selectedPct = null);
                            _refreshQuote();
                          },
                        ),
                        if (['USDC', 'EURC', 'CIRBTC'].contains(_fromPreset))
                          Text(
                            'Available ${avail.toStringAsFixed(_fromPreset == 'CIRBTC' ? 6 : 2)}',
                            style: const TextStyle(
                              fontSize: 10,
                              color: EvabobColors.chalk,
                            ),
                          ),
                        const SizedBox(height: 12),
                        // Percentage of available balance
                        Row(
                          children: [
                            for (final pct in [10, 25, 50, 100]) ...[
                              Expanded(
                                child: PressScale(
                                  onTap: () => _setPct(pct, wallet),
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
                                            : EvabobColors.hairline,
                                      ),
                                    ),
                                    child: Text(
                                      '$pct%',
                                      style: TextStyle(
                                        fontWeight: FontWeight.w400,
                                        fontSize: 10,
                                        color: _selectedPct == pct
                                            ? EvabobColors.emeraldDeep
                                            : EvabobColors.navyMuted,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                              if (pct != 100) const SizedBox(width: 8),
                            ],
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 4),
                  Center(
                    child: Semantics(
                      button: true,
                      label: 'Swap which currency you are spending',
                      child: PressScale(
                        onTap: () {
                          setState(() {
                            final fp = _fromPreset;
                            final fc = _fromCa.text;
                            final fd = _fromDec.text;
                            _fromPreset = _toPreset;
                            _toPreset = fp;
                            _fromCa.text = _toCa.text;
                            _toCa.text = fc;
                            _fromDec.text = _toDec.text;
                            _toDec.text = fd;
                            _swapTurns += 1;
                            _selectedPct = null;
                            _quotedOut = null;
                            _quoteLine = null;
                          });
                          _refreshQuote();
                        },
                        child: AnimatedRotation(
                          turns: _swapTurns * 0.5,
                          duration: const Duration(milliseconds: 480),
                          curve: Curves.easeOutBack,
                          child: Glass(
                            borderRadius: 999,
                            padding: const EdgeInsets.all(12),
                            child: const Icon(
                              Icons.swap_vert_rounded,
                              color: EvabobColors.emeraldDeep,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Glass(
                    heavy: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _tokenPicker(
                          label: 'You receive',
                          preset: _toPreset,
                          onPreset: (v) {
                            setState(() {
                              _toPreset = v;
                              _quotedOut = null;
                              _quoteLine = null;
                            });
                            _refreshQuote();
                          },
                          ca: _toCa,
                          dec: _toDec,
                        ),
                        const SizedBox(height: 10),
                        Text(
                          amount <= 0
                              ? '0 ${_label(_toPreset, _toCa)}'
                              : '${converted.toStringAsFixed(_dp(_toPreset))} ${_label(_toPreset, _toCa)}',
                          style:
                              EvabobTheme.amountDisplay.copyWith(fontSize: 48),
                        )
                            .animate(key: ValueKey(converted))
                            .fadeIn(duration: 280.ms),
                        if (_quoteLine != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 6),
                            child: Text(
                              _quoteLine!,
                              style: const TextStyle(
                                color: EvabobColors.chalk,
                                fontSize: 10,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  EvabobPrimaryButton(
                    label: canBuy ? 'Convert' : 'Enter amount',
                    onPressed: canBuy ? _executeBuy : null,
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

Future<void> _showDone(BuildContext context, String detail) {
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
              Icons.swap_horiz_rounded,
              size: 38,
              color: EvabobColors.ink,
            ),
          ),
          const SizedBox(height: Space.xl),
          Text('Done', style: Type.title),
          const SizedBox(height: Space.sm),
          Text(
            detail,
            textAlign: TextAlign.center,
            style: Type.body.copyWith(color: EvabobColors.inkMuted),
          ),
          const SizedBox(height: Space.xxl),
          SizedBox(
            width: double.infinity,
            height: 56,
            child: FilledButton(
              onPressed: () => Navigator.pop(sheetContext),
              child: const Text('Done'),
            ),
          ),
        ],
      ),
    ),
  );
}
