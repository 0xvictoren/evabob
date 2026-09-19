import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/security/app_lock_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';

/// Blocks the rest of the app until local PIN / biometrics succeed.
class AppLockScreen extends StatefulWidget {
  const AppLockScreen({super.key, this.setupMode = false});

  /// When true, first-time create PIN UI (not unlock).
  final bool setupMode;

  @override
  State<AppLockScreen> createState() => _AppLockScreenState();
}

class _AppLockScreenState extends State<AppLockScreen> {
  final _pin = TextEditingController();
  bool _busy = false;
  bool _useBio = true;
  bool _confirming = false;
  String? _firstPin;
  String? _localError;
  int _failedAttempts = 0;
  DateTime? _lockedUntil;
  Timer? _lockTimer;

  bool get _isLocked =>
      _lockedUntil != null && DateTime.now().isBefore(_lockedUntil!);

  @override
  void initState() {
    super.initState();
    if (!widget.setupMode) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _tryBio());
    }
  }

  @override
  void dispose() {
    _lockTimer?.cancel();
    _pin.dispose();
    super.dispose();
  }

  Future<void> _tryBio() async {
    final lock = context.read<AppLockService>();
    if (!lock.bioEnabled || !lock.bioAvailable || _busy) return;
    setState(() => _busy = true);
    await lock.unlockWithBiometrics();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _submitUnlock() async {
    if (_isLocked || _pin.text.isEmpty) return;
    final lock = context.read<AppLockService>();
    setState(() {
      _busy = true;
      _localError = null;
    });
    final ok = await lock.unlockWithPin(_pin.text);
    if (!mounted) return;
    _pin.clear();
    if (ok) {
      setState(() => _busy = false);
      return;
    }
    _failedAttempts += 1;
    if (_failedAttempts >= 5) {
      _startLockout();
    } else {
      setState(() {
        _busy = false;
        _localError = 'Wrong PIN. Try again.';
      });
    }
  }

  void _startLockout() {
    _lockedUntil = DateTime.now().add(const Duration(seconds: 30));
    _localError = null;
    _busy = false;
    _lockTimer?.cancel();
    _lockTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      if (!_isLocked) {
        timer.cancel();
        setState(() {
          _lockedUntil = null;
          _failedAttempts = 0;
        });
      } else {
        setState(() {});
      }
    });
    setState(() {});
  }

  Future<void> _submitSetup() async {
    final value = _pin.text.trim();
    if (value.length < 4) {
      setState(() => _localError = 'Use at least 4 digits');
      return;
    }
    if (!_confirming) {
      setState(() {
        _firstPin = value;
        _confirming = true;
        _localError = null;
        _pin.clear();
      });
      return;
    }
    if (value != _firstPin) {
      setState(() {
        _localError = 'Those PINs do not match. Try again.';
        _pin.clear();
      });
      return;
    }

    final lock = context.read<AppLockService>();
    setState(() {
      _busy = true;
      _localError = null;
    });
    final ok = await lock.setPin(value, enableBiometrics: _useBio);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (!ok) _localError = lock.error ?? 'Could not save PIN';
    });
    if (ok && mounted) Navigator.of(context).maybePop(true);
  }

  Future<void> _showForgotPin() async {
    final lock = context.read<AppLockService>();
    await showModalBottomSheet<void>(
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
          color: Colors.white,
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
            const SizedBox(height: Space.xl),
            const CircleAvatar(
              radius: 34,
              backgroundColor: EvabobColors.blueSoft,
              child: Icon(
                Icons.lock_reset_rounded,
                color: EvabobColors.ink,
                size: 30,
              ),
            ),
            const SizedBox(height: Space.lg),
            Text('Forgot your PIN?', style: Type.title),
            const SizedBox(height: Space.sm),
            Text(
              lock.bioEnabled && lock.bioAvailable
                  ? 'Use the fingerprint or face already saved on this phone to unlock Evabob.'
                  : 'For your security, an app-lock PIN cannot be shown or recovered. Contact support from another device if you are locked out.',
              textAlign: TextAlign.center,
              style: Type.body.copyWith(color: EvabobColors.inkMuted),
            ),
            const SizedBox(height: Space.xl),
            if (lock.bioEnabled && lock.bioAvailable)
              SizedBox(
                width: double.infinity,
                height: 56,
                child: FilledButton.icon(
                  onPressed: () {
                    Navigator.pop(sheetContext);
                    _tryBio();
                  },
                  icon: const Icon(Icons.fingerprint_rounded),
                  label: const Text('Use biometrics'),
                ),
              ),
            const SizedBox(height: Space.sm),
            TextButton(
              onPressed: () => Navigator.pop(sheetContext),
              child: const Text('Back to PIN'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final lock = context.watch<AppLockService>();
    final setup = widget.setupMode;
    final title = setup
        ? (_confirming ? 'Confirm your PIN' : 'Create an app lock')
        : (_isLocked ? 'Too many tries' : 'App lock');
    final subtitle = setup
        ? (_confirming
            ? 'Enter the same PIN again so we know you have it.'
            : 'Use a PIN to keep money and messages private on this phone.')
        : (_isLocked
            ? 'Try again in ${_lockedUntil!.difference(DateTime.now()).inSeconds + 1} seconds.'
            : 'Enter your PIN to open Evabob.');

    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      appBar: setup
          ? AppBar(
              backgroundColor: EvabobColors.pageBg,
              surfaceTintColor: Colors.transparent,
              leading: IconButton(
                onPressed: _confirming
                    ? () => setState(() {
                          _confirming = false;
                          _firstPin = null;
                          _pin.clear();
                          _localError = null;
                        })
                    : () => Navigator.maybePop(context),
                icon: const Icon(Icons.arrow_back_rounded),
              ),
            )
          : null,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            Space.page,
            Space.xxl,
            Space.page,
            Space.page,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              CircleAvatar(
                radius: 44,
                backgroundColor:
                    _isLocked ? const Color(0x14CF3345) : EvabobColors.blueSoft,
                child: Icon(
                  _isLocked ? Icons.timer_outlined : Icons.lock_outline_rounded,
                  size: 36,
                  color: EvabobColors.ink,
                ),
              ),
              const SizedBox(height: Space.xl),
              Text(title, textAlign: TextAlign.center, style: Type.title),
              const SizedBox(height: Space.sm),
              Text(
                subtitle,
                textAlign: TextAlign.center,
                style: Type.body.copyWith(color: EvabobColors.inkMuted),
              ),
              const SizedBox(height: Space.xxl),
              TextField(
                controller: _pin,
                enabled: !_busy && !_isLocked,
                autofocus: true,
                obscureText: true,
                textAlign: TextAlign.center,
                keyboardType: TextInputType.number,
                style: Type.title.copyWith(letterSpacing: 12),
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(12),
                ],
                decoration: InputDecoration(
                  hintText: '••••••',
                  hintStyle: Type.title.copyWith(
                    color: EvabobColors.ink.withValues(alpha: .18),
                    letterSpacing: 12,
                  ),
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(Radii.md),
                    borderSide: BorderSide.none,
                  ),
                ),
                onChanged: (_) {
                  if (_localError != null) setState(() => _localError = null);
                },
                onSubmitted: (_) => setup ? _submitSetup() : _submitUnlock(),
              ),
              AnimatedSwitcher(
                duration: Motion.fast,
                child: _localError == null
                    ? const SizedBox(height: Space.xl)
                    : Padding(
                        padding: const EdgeInsets.only(top: Space.md),
                        child: Container(
                          padding: const EdgeInsets.all(Space.md),
                          decoration: BoxDecoration(
                            color: const Color(0x14CF3345),
                            borderRadius: BorderRadius.circular(Radii.sm),
                          ),
                          child: Row(
                            children: [
                              const Icon(
                                Icons.error_outline_rounded,
                                color: EvabobColors.alert,
                                size: 18,
                              ),
                              const SizedBox(width: Space.sm),
                              Expanded(
                                child: Text(
                                  _localError!,
                                  style: Type.body.copyWith(
                                    color: EvabobColors.alert,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
              ),
              const Spacer(),
              if (setup && !_confirming && lock.bioAvailable)
                SwitchListTile.adaptive(
                  contentPadding: EdgeInsets.zero,
                  title: Text('Use fingerprint or face', style: Type.body),
                  subtitle: Text(
                    'You can change this later in Profile.',
                    style: Type.label.copyWith(color: EvabobColors.inkMuted),
                  ),
                  value: _useBio,
                  onChanged: (value) => setState(() => _useBio = value),
                ),
              SizedBox(
                height: 56,
                child: FilledButton(
                  onPressed: _busy || _isLocked
                      ? null
                      : () => setup ? _submitSetup() : _submitUnlock(),
                  child: Text(
                    _busy
                        ? 'Checking…'
                        : setup
                            ? (_confirming ? 'Confirm PIN' : 'Continue')
                            : 'Unlock',
                  ),
                ),
              ),
              if (!setup) ...[
                const SizedBox(height: Space.sm),
                TextButton(
                  onPressed: _busy ? null : _showForgotPin,
                  child: const Text('Forgot your PIN?'),
                ),
              ],
              if (!setup && lock.bioEnabled && lock.bioAvailable) ...[
                const SizedBox(height: Space.xs),
                OutlinedButton.icon(
                  onPressed: _busy ? null : _tryBio,
                  icon: const Icon(Icons.fingerprint_rounded),
                  label: const Text('Use biometrics'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
