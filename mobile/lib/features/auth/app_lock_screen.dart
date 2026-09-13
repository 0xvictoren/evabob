import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/security/app_lock_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/widgets/glass.dart';

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
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _localError;
  bool _useBio = true;

  @override
  void initState() {
    super.initState();
    if (!widget.setupMode) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _tryBio());
    }
  }

  @override
  void dispose() {
    _pin.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _tryBio() async {
    final lock = context.read<AppLockService>();
    if (!lock.bioEnabled || !lock.bioAvailable) return;
    setState(() => _busy = true);
    await lock.unlockWithBiometrics();
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _submitUnlock() async {
    final lock = context.read<AppLockService>();
    setState(() {
      _busy = true;
      _localError = null;
    });
    final ok = await lock.unlockWithPin(_pin.text);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (!ok) _localError = lock.error ?? 'Incorrect PIN';
    });
  }

  Future<void> _submitSetup() async {
    final lock = context.read<AppLockService>();
    final a = _pin.text.trim();
    final b = _confirm.text.trim();
    if (a.length < 4) {
      setState(() => _localError = 'Use at least 4 digits');
      return;
    }
    if (a != b) {
      setState(() => _localError = 'PINs do not match');
      return;
    }
    setState(() {
      _busy = true;
      _localError = null;
    });
    final ok = await lock.setPin(a, enableBiometrics: _useBio);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (!ok) _localError = lock.error ?? 'Could not save PIN';
    });
    if (ok && mounted) Navigator.of(context).maybePop(true);
  }

  @override
  Widget build(BuildContext context) {
    final lock = context.watch<AppLockService>();
    final setup = widget.setupMode;

    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(gradient: EvabobColors.meshWarm),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Glass(
                heavy: true,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(
                      setup ? Icons.lock_outline_rounded : Icons.lock_rounded,
                      size: 40,
                      color: EvabobColors.emeraldDeep,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      setup ? 'Create app lock' : 'Unlock Evabob',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w400,
                        color: EvabobColors.navy,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      setup
                          ? 'This PIN unlocks the app on this phone. The one you use to approve a payment is separate.'
                          : 'Enter your app PIN or use biometrics to continue.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 10,
                        color: EvabobColors.navyMuted,
                      ),
                    ),
                    const SizedBox(height: 20),
                    TextField(
                      controller: _pin,
                      obscureText: true,
                      keyboardType: TextInputType.number,
                      inputFormatters: [
                        FilteringTextInputFormatter.digitsOnly,
                        LengthLimitingTextInputFormatter(12),
                      ],
                      decoration: InputDecoration(
                        labelText: setup ? 'Create PIN' : 'App PIN',
                        border: const OutlineInputBorder(),
                      ),
                      onSubmitted: (_) =>
                          setup ? _submitSetup() : _submitUnlock(),
                    ),
                    if (setup) ...[
                      const SizedBox(height: 12),
                      TextField(
                        controller: _confirm,
                        obscureText: true,
                        keyboardType: TextInputType.number,
                        inputFormatters: [
                          FilteringTextInputFormatter.digitsOnly,
                          LengthLimitingTextInputFormatter(12),
                        ],
                        decoration: const InputDecoration(
                          labelText: 'Confirm PIN',
                          border: OutlineInputBorder(),
                        ),
                        onSubmitted: (_) => _submitSetup(),
                      ),
                      if (lock.bioAvailable) ...[
                        const SizedBox(height: 8),
                        SwitchListTile(
                          contentPadding: EdgeInsets.zero,
                          title: const Text('Use fingerprint / face'),
                          value: _useBio,
                          onChanged: (v) => setState(() => _useBio = v),
                        ),
                      ],
                    ],
                    if (_localError != null || lock.error != null) ...[
                      const SizedBox(height: 10),
                      Text(
                        _localError ?? lock.error!,
                        style: TextStyle(
                          color: EvabobColors.alert,
                          fontSize: 10,
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    FilledButton(
                      onPressed: _busy
                          ? null
                          : () => setup ? _submitSetup() : _submitUnlock(),
                      child: Text(_busy
                          ? 'Please wait…'
                          : setup
                              ? 'Save & continue'
                              : 'Unlock'),
                    ),
                    if (!setup && lock.bioEnabled && lock.bioAvailable) ...[
                      const SizedBox(height: 10),
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
          ),
        ),
      ),
    );
  }
}
