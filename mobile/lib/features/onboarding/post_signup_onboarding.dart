import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/evabob_auth.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/evabob_ui.dart';
import '../shell/app_shell.dart';
import '../wallet/circle_onboard_sheet.dart';

/// Server-backed gate between a first Dynamic login and the dashboard.
/// Existing accounts (whose legacy records have no onboarding marker) pass
/// through after session sync; new accounts must create a wallet and confirm a
/// preferred handle.
class PostSignupOnboarding extends StatefulWidget {
  const PostSignupOnboarding({super.key});

  @override
  State<PostSignupOnboarding> createState() => _PostSignupOnboardingState();
}

class _PostSignupOnboardingState extends State<PostSignupOnboarding> {
  final _handle = TextEditingController();
  bool _checking = true;
  bool _busy = false;
  bool _walletReady = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _handle.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() {
      _checking = true;
      _error = null;
    });
    await context.read<WalletService>().syncSession();
    if (!mounted) return;
    final user = context.read<EvabobAuth>().user;
    if (user?.onboardingRequired == null) {
      setState(() {
        _checking = false;
        _error = 'Could not check your account setup. Try again.';
      });
      return;
    }
    if (user!.onboardingRequired == true) {
      _walletReady =
          user.smartAccount.startsWith('0x') && user.smartAccount.length == 42;
      if (_handle.text.isEmpty) _handle.text = user.handleOrFallback;
    }
    setState(() => _checking = false);
  }

  Future<void> _createWallet() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final ok = await openCircleWalletOnboarding(context);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _walletReady = ok &&
          (context.read<CircleWalletService>().address?.startsWith('0x') ??
              false);
      if (!_walletReady) {
        _error = 'Wallet setup is not finished yet. Please try again.';
      }
    });
  }

  Future<void> _saveHandle() async {
    if (_busy) return;
    final handle =
        _handle.text.trim().replaceFirst(RegExp(r'^@'), '').toLowerCase();
    if (!RegExp(r'^[a-z0-9_]{3,24}$').hasMatch(handle)) {
      setState(() {
        _error = 'Use 3–24 letters, numbers, or underscores.';
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = context.read<ApiClient>();
      final auth = context.read<EvabobAuth>();
      await api.post('/v1/users/handle', body: {'handle': handle});
      final result = await api.post('/v1/users/onboarding/complete');
      final serverUser = result['user'];
      if (serverUser is Map) {
        await auth.applyServerProfile(
          Map<String, dynamic>.from(serverUser),
        );
      } else {
        await auth.setHandle(handle);
        await auth.setOnboardingRequired(false);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = friendlyError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<EvabobAuth>();
    if (!_checking && auth.user?.onboardingRequired == false) {
      return const AppShell();
    }
    return Scaffold(
      backgroundColor: EvabobColors.white,
      body: SafeArea(
        child: _checking
            ? const Center(
                child: CircularProgressIndicator(color: EvabobColors.blue),
              )
            : ListView(
                padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
                children: [
                  Align(
                    alignment: Alignment.centerLeft,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: Image.asset(
                        'assets/logo.png',
                        width: 32,
                        height: 32,
                      ),
                    ),
                  ),
                  const SizedBox(height: 44),
                  Text(
                    _walletReady ? 'Choose your name' : 'Set up your wallet',
                    style: Type.title,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _walletReady
                        ? 'This is how people can find and pay you. You can use the suggestion or enter your own.'
                        : 'Create your secure account and choose a PIN before you start using Evabob.',
                    style: Type.body.copyWith(color: EvabobColors.inkMuted),
                  ),
                  const SizedBox(height: 36),
                  if (_walletReady) ...[
                    Text(
                      'Preferred handle',
                      style: Type.label.copyWith(
                        color: EvabobColors.inkTertiary,
                      ),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _handle,
                      enabled: !_busy,
                      autocorrect: false,
                      textCapitalization: TextCapitalization.none,
                      decoration: const InputDecoration(
                        prefixText: '@',
                        hintText: 'yourname',
                        helperText: 'Letters, numbers and underscores only',
                      ),
                      onSubmitted: (_) => _saveHandle(),
                    ),
                  ] else
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: EvabobColors.blue.withValues(alpha: .06),
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: const Row(
                        children: [
                          Icon(
                            Icons.lock_outline_rounded,
                            color: EvabobColors.blue,
                          ),
                          SizedBox(width: 14),
                          Expanded(
                            child: Text(
                              'Your wallet is protected by a PIN that only you know.',
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Text(
                      _error!,
                      style: Type.label.copyWith(color: EvabobColors.alert),
                    ),
                  ],
                  const SizedBox(height: 28),
                  EvabobPrimaryButton(
                    label:
                        _walletReady ? 'Continue to Evabob' : 'Create wallet',
                    onPressed: _busy
                        ? null
                        : (_walletReady ? _saveHandle : _createWallet),
                    busy: _busy,
                  ),
                  if (_error != null && !_walletReady) ...[
                    const SizedBox(height: 12),
                    TextButton(
                      onPressed: _busy ? null : _load,
                      child: const Text('Check again'),
                    ),
                  ],
                  const SizedBox(height: 18),
                  TextButton(
                    onPressed: _busy ? null : auth.signOut,
                    child: const Text('Sign out'),
                  ),
                ],
              ),
      ),
    );
  }
}
