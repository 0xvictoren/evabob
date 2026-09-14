import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/auth/evabob_auth.dart';
import '../../core/config/env.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/evabob_ui.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _code = TextEditingController();
  bool _codeSent = false;
  bool _busy = false;

  @override
  void dispose() {
    _email.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _primary(EvabobAuth auth) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      if (!_codeSent) {
        final ok = await auth.sendEmailCode(_email.text.trim());
        if (ok && mounted) {
          setState(() {
            _codeSent = true;
            _code.clear();
          });
        }
        return;
      }
      final ok = await auth.loginWithEmailCode(
        email: _email.text.trim(),
        code: _code.text,
      );
      if (!mounted) return;
      if (!ok) {
        if (auth.needsNewOtp) _code.clear();
        return;
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _codeKey(String key, EvabobAuth auth) {
    if (_busy) return;
    final current = _code.text;
    if (key == '⌫') {
      if (current.isNotEmpty) {
        setState(() => _code.text = current.substring(0, current.length - 1));
      }
      return;
    }
    if (current.length >= 6) return;
    setState(() => _code.text = '$current$key');
    if (_code.text.length == 6) _primary(auth);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<EvabobAuth>();
    final circle = context.watch<CircleWalletService>();
    final loading = _busy || auth.isLoading || circle.busy;
    return Scaffold(
      backgroundColor: EvabobColors.white,
      body: SafeArea(
        child: AnimatedSwitcher(
          duration: Motion.fast,
          child: _codeSent
              ? _CodeView(
                  key: const ValueKey('code'),
                  email: _email.text.trim(),
                  code: _code.text,
                  error: auth.error,
                  loading: loading,
                  onBack: () => setState(() {
                    _codeSent = false;
                    _code.clear();
                  }),
                  onKey: (key) => _codeKey(key, auth),
                  onResend: loading
                      ? null
                      : () async {
                          await auth.resendEmailCode();
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('New code sent')),
                          );
                        },
                )
              : _EmailView(
                  key: const ValueKey('email'),
                  controller: _email,
                  error: auth.error,
                  loading: loading,
                  onContinue: () => _primary(auth),
                  onDemo: kDebugMode && Env.demoEnabled && !loading
                      ? () => auth.continueAsDemo('Victor')
                      : null,
                ),
        ),
      ),
    );
  }
}

class _EmailView extends StatelessWidget {
  const _EmailView({
    super.key,
    required this.controller,
    required this.error,
    required this.loading,
    required this.onContinue,
    required this.onDemo,
  });

  final TextEditingController controller;
  final String? error;
  final bool loading;
  final VoidCallback onContinue;
  final VoidCallback? onDemo;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.asset('assets/logo.png', width: 32, height: 32),
          ),
        ),
        const SizedBox(height: 16),
        Semantics(
          header: true,
          child: Text("Let's get you in", style: Type.title),
        ),
        const SizedBox(height: 4),
        Text(
          "We'll email you a six-digit code",
          style: Type.body.copyWith(color: EvabobColors.inkMuted),
        ),
        const SizedBox(height: 42),
        Text(
          'Email',
          style: Type.label.copyWith(color: EvabobColors.inkTertiary),
        ),
        const SizedBox(height: 8),
        Container(
          height: 64,
          alignment: Alignment.center,
          decoration: const BoxDecoration(
            color: EvabobColors.white,
            borderRadius: BorderRadius.all(Radius.circular(12)),
            boxShadow: Shadows.card,
          ),
          child: TextField(
            controller: controller,
            enabled: !loading,
            keyboardType: TextInputType.emailAddress,
            autocorrect: false,
            autofillHints: const [AutofillHints.email],
            style: Type.body,
            decoration: const InputDecoration(
              hintText: 'you@example.com',
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              contentPadding: EdgeInsets.symmetric(horizontal: 20),
            ),
            onSubmitted: (_) => onContinue(),
          ),
        ),
        if (error != null) ...[
          const SizedBox(height: 10),
          Text(error!, style: Type.label.copyWith(color: EvabobColors.alert)),
        ],
        const SizedBox(height: 32),
        EvabobPrimaryButton(
          label: 'Send me a code',
          onPressed: loading ? null : onContinue,
          busy: loading,
        ),
        const SizedBox(height: 76),
        Text(
          'By continuing you agree to the Terms and the Privacy Notice',
          textAlign: TextAlign.center,
          style: Type.label.copyWith(color: EvabobColors.inkTertiary),
        ),
        if (onDemo != null) ...[
          const SizedBox(height: 24),
          TextButton(
            onPressed: onDemo,
            child: const Text('Open demo account'),
          ),
        ],
      ],
    );
  }
}

class _CodeView extends StatelessWidget {
  const _CodeView({
    super.key,
    required this.email,
    required this.code,
    required this.error,
    required this.loading,
    required this.onBack,
    required this.onKey,
    required this.onResend,
  });

  final String email;
  final String code;
  final String? error;
  final bool loading;
  final VoidCallback onBack;
  final ValueChanged<String> onKey;
  final VoidCallback? onResend;

  static const _keys = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['', '0', '⌫'],
  ];

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
      children: [
        EvabobPageHeader(title: 'Sign in', onBack: onBack),
        const SizedBox(height: 22),
        Semantics(
            header: true, child: Text('Enter the code', style: Type.title)),
        const SizedBox(height: 4),
        Text(
          'We sent six digits to $email',
          style: Type.body.copyWith(color: EvabobColors.inkMuted),
        ),
        const SizedBox(height: 32),
        Row(
          children: [
            for (var i = 0; i < 6; i++) ...[
              Expanded(
                child: Container(
                  height: 56,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: EvabobColors.pageBg,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child:
                      Text(i < code.length ? code[i] : '', style: Type.title),
                ),
              ),
              if (i != 5) const SizedBox(width: 8),
            ],
          ],
        ),
        if (error != null) ...[
          const SizedBox(height: 10),
          Text(error!, style: Type.label.copyWith(color: EvabobColors.alert)),
        ],
        const SizedBox(height: 12),
        TextButton(
          onPressed: onResend,
          child: const Text('Send a new code'),
        ),
        if (loading) ...[
          const SizedBox(height: 8),
          const Center(
            child: SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          ),
        ],
        const SizedBox(height: 20),
        for (final row in _keys)
          Row(
            children: [
              for (final key in row)
                Expanded(
                  child: SizedBox(
                    height: 64,
                    child: key.isEmpty
                        ? const SizedBox.shrink()
                        : InkWell(
                            onTap: loading ? null : () => onKey(key),
                            borderRadius: BorderRadius.circular(14),
                            child: Center(
                              child: key == '⌫'
                                  ? const Icon(
                                      Icons.backspace_outlined,
                                      color: EvabobColors.inkMuted,
                                      size: 20,
                                    )
                                  : Text(key, style: Type.title),
                            ),
                          ),
                  ),
                ),
            ],
          ),
      ],
    );
  }
}
