import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/auth/evabob_auth.dart';

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
  Timer? _lockTimer;

  bool get _isLocked => context.read<AppLockService>().pinBlocked;

  @override
  void initState() {
    super.initState();
    if (!widget.setupMode) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final lock = context.read<AppLockService>();
        if (lock.pinBlocked) {
          _startLockout();
        } else {
          _tryBio();
        }
      });
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
    _startLockout();
  }

  void _startLockout() {
    final lock = context.read<AppLockService>();
    _localError = lock.error;
    _busy = false;
    _lockTimer?.cancel();
    _lockTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) return;
      if (!_isLocked) {
        timer.cancel();
        setState(() {
          _localError = null;
        });
      } else {
        setState(() {});
      }
    });
    setState(() {});
  }

  Future<void> _submitSetup() async {
    final value = _pin.text.trim();
    if (!RegExp(r'^\d{6,12}$').hasMatch(value)) {
      setState(() => _localError = 'Use at least 6 digits');
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
            CircleAvatar(
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
    // Figma "Locked out" (43:1953) while PIN entry is blocked.
    if (!setup && lock.pinBlocked) {
      return _LockedOutView(
        onUnblocked: () {
          if (mounted) setState(() => _localError = null);
        },
      );
    }
    final title = setup
        ? (_confirming ? 'Confirm your PIN' : 'Create an app lock')
        : (_isLocked ? 'Too many tries' : 'App lock');
    final subtitle = setup
        ? (_confirming
            ? 'Enter the same PIN again so we know you have it.'
            : 'Use a PIN to keep money and messages private on this phone.')
        : (_isLocked
            ? 'Try again in ${lock.retryAfter.inSeconds + 1} seconds.'
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
                  LengthLimitingTextInputFormatter(
                    setup ? 12 : (lock.pinLength ?? 12),
                  ),
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
                onChanged: (value) {
                  if (_localError != null) setState(() => _localError = null);
                  // Unlocking checks the PIN the moment its last digit is in:
                  // no Unlock tap. Only once the PIN's length is known — a
                  // guess at it would spend an attempt on a half-typed PIN.
                  final len = lock.pinLength;
                  if (!setup &&
                      len != null &&
                      value.length == len &&
                      !_busy &&
                      !_isLocked) {
                    _submitUnlock();
                  }
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

/// Figma "Locked out" (43:1953): how long until they can try again, that
/// their money is safe, and a way back in with their email now.
class _LockedOutView extends StatefulWidget {
  const _LockedOutView({required this.onUnblocked});

  final VoidCallback onUnblocked;

  @override
  State<_LockedOutView> createState() => _LockedOutViewState();
}

class _LockedOutViewState extends State<_LockedOutView> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (!context.read<AppLockService>().pinBlocked) {
        _tick?.cancel();
        widget.onUnblocked();
      }
      setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  static String _clock(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }

  /// Signing in with email proves who they are, so the app lock is cleared
  /// and set up again afterwards. Nothing about the money changes.
  Future<void> _signInWithEmail() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign in with email?'),
        content: const Text(
          'You will sign in again with your email code. Your app lock is '
          'turned off so you can set a new PIN. Your money stays where it is.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final lock = context.read<AppLockService>();
    final auth = context.read<EvabobAuth>();
    await lock.disableLock();
    await auth.signOut();
  }

  void _help() {
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
              Text('Get help', style: Type.title),
              const SizedBox(height: 8),
              Text(
                'The quickest way back is to sign in with your email. If you '
                'no longer have that email, contact Evabob support from a '
                'device you still control.',
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

  static const _words = [
    'Zero',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
  ];

  @override
  Widget build(BuildContext context) {
    final lock = context.watch<AppLockService>();
    final n = lock.failedAttempts;
    final count = n >= 0 && n < _words.length ? _words[n] : '$n';
    return Scaffold(
      backgroundColor: EvabobColors.white,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 86),
              Center(
                child: Container(
                  width: 56,
                  height: 56,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: EvabobColors.pageBg,
                    shape: BoxShape.circle,
                  ),
                  child: Image.asset('assets/logo.png', width: 28, height: 28),
                ),
              ),
              const SizedBox(height: 24),
              Text(
                'Locked for now',
                textAlign: TextAlign.center,
                style: Type.title.copyWith(
                  fontSize: 24,
                  height: 32 / 24,
                  letterSpacing: -0.4,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                n == 1 ? 'One wrong PIN' : '$count wrong PINs in a row',
                textAlign: TextAlign.center,
                style: Type.body.copyWith(color: EvabobColors.slate),
              ),
              const SizedBox(height: 38),
              Text(
                _clock(lock.retryAfter),
                textAlign: TextAlign.center,
                style: Type.hero,
              ),
              const SizedBox(height: 10),
              const Text(
                'UNTIL YOU CAN TRY AGAIN',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 10,
                  height: 14 / 10,
                  letterSpacing: .8,
                  color: EvabobColors.inkTertiary,
                ),
              ),
              const SizedBox(height: 40),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                decoration: const BoxDecoration(
                  color: EvabobColors.white,
                  borderRadius: BorderRadius.all(Radius.circular(12)),
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
                    SizedBox(
                      height: 72,
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          'Your money is safe. Nothing has moved.',
                          style: Type.body,
                        ),
                      ),
                    ),
                    const Divider(height: 1, color: EvabobColors.hairline),
                    SizedBox(
                      height: 71,
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          'Sign in with your email to get back in now',
                          style: Type.body,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 76),
              DecoratedBox(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.all(Radius.circular(12)),
                  boxShadow: [
                    BoxShadow(
                      color: EvabobColors.buttonGlow,
                      blurRadius: 24,
                      spreadRadius: -6,
                    ),
                  ],
                ),
                child: SizedBox(
                  height: 56,
                  child: FilledButton(
                    onPressed: _signInWithEmail,
                    style: FilledButton.styleFrom(
                      backgroundColor: EvabobColors.blue,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                    ),
                    child: Text(
                      'Sign in with email',
                      style: Type.body.copyWith(color: EvabobColors.white),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              Center(
                child: GestureDetector(
                  onTap: _help,
                  child: Text(
                    'Get help',
                    style: Type.body.copyWith(color: EvabobColors.blue),
                  ),
                ),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}
