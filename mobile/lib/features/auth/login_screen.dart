import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/auth/evabob_auth.dart';
import '../../core/config/env.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/evabob_ui.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

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
  void initState() {
    super.initState();
    // Back after a sign-in ended: the email is already known.
    final ended = context.read<EvabobAuth>().sessionEndedEmail;
    if (ended != null) _email.text = ended;
  }

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

  /// Fills the code from the clipboard: the six digits in whatever was
  /// copied from the email ("123 456", "123-456", or the whole sentence).
  Future<void> _pasteCode(EvabobAuth auth) async {
    if (_busy) return;
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    if (!mounted) return;
    final text = data?.text ?? '';
    final digits = text.replaceAll(RegExp(r'\D'), '');
    final code = digits.length == 6
        ? digits
        : RegExp(r'(?<!\d)\d{6}(?!\d)').firstMatch(text)?.group(0);
    if (code == null) {
      showTopSnack(
        context,
        const SnackBar(content: Text('Copy the six-digit code first')),
      );
      return;
    }
    setState(() => _code.text = code);
    await _primary(auth);
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
                  onPaste: loading ? null : () => _pasteCode(auth),
                  onResend: loading
                      ? null
                      : () async {
                          await auth.resendEmailCode();
                          if (!context.mounted) return;
                          showTopSnack(
                            context,
                            const SnackBar(content: Text('New code sent')),
                          );
                        },
                )
              : _EmailView(
                  key: const ValueKey('email'),
                  controller: _email,
                  sessionEnded: auth.sessionEndedEmail != null,
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
    this.sessionEnded = false,
  });

  final TextEditingController controller;

  /// The person was signed in, and their sign-in ran out.
  final bool sessionEnded;
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
          child: Text(
            sessionEnded ? 'Welcome back' : "Let's get you in",
            style: Type.title,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          sessionEnded
              ? 'Your sign-in ended, so we need to check it is you. We will '
                  'email you a six-digit code. Your wallet and money are just '
                  'as you left them.'
              : "We'll email you a six-digit code",
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
    this.onPaste,
  });

  final String email;
  final String code;
  final String? error;
  final bool loading;
  final VoidCallback onBack;
  final ValueChanged<String> onKey;
  final VoidCallback? onResend;
  final VoidCallback? onPaste;

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
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            TextButton.icon(
              onPressed: onPaste,
              icon: const Icon(Icons.content_paste_rounded, size: 18),
              label: const Text('Paste code'),
            ),
            TextButton(
              onPressed: onResend,
              child: const Text('Send a new code'),
            ),
          ],
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
