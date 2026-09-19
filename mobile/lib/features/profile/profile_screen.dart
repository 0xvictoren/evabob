import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/held/operator_reviews_api.dart';
import '../../core/utils/text_safe.dart';
import '../../core/auth/evabob_auth.dart';
import '../../core/security/app_lock_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/wallet/circle_native_sdk.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/confirm_action_dialog.dart';
import '../../core/widgets/bundle_avatar.dart';
import '../../core/widgets/glass.dart';
import '../auth/app_lock_screen.dart';
import '../held/operator_reviews_screen.dart';
import 'family_check_screen.dart';
// Gateway parked for later.
// import '../gateway/gateway_screen.dart';
import '../wallet/circle_onboard_sheet.dart';

/// Profile: identity, wallet, appearance, sign out.
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, this.onBack, this.showBack = true});

  final VoidCallback? onBack;
  final bool showBack;

  static const _maxAvatarBytes = 256 * 1024;

  Future<void> _editDisplayName(BuildContext context, EvabobAuth auth) async {
    final ctrl = TextEditingController(text: auth.user?.displayName ?? '');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Display name'),
        content: TextField(
          controller: ctrl,
          decoration: const InputDecoration(
            labelText: 'Shown in the app',
            helperText:
                'Changeable every 7 weeks. People still send to @username or your email.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (ok == true && ctrl.text.trim().isNotEmpty && context.mounted) {
      try {
        await context.read<ApiClient>().post('/v1/users/me', body: {
          'displayName': ctrl.text.trim(),
        });
        await auth.setDisplayName(ctrl.text.trim());
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text(friendlyError(e)),
              behavior: SnackBarBehavior.floating,
            ),
          );
        }
        return;
      }
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Display name updated'),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  Future<void> _editHandle(BuildContext context, EvabobAuth auth) async {
    final current = auth.user?.handleOrFallback ?? '';
    final ctrl = TextEditingController(text: current);
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('@handle'),
        content: TextField(
          controller: ctrl,
          decoration: const InputDecoration(
            labelText: 'Handle for sends (not your display name)',
            prefixText: '@',
            helperText:
                'For sends. Not your display name. First change free, then every 2 months.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final handle = ctrl.text.trim().replaceAll('@', '').toLowerCase();
    if (handle.length < 3) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Handle must be at least 3 characters'),
          behavior: SnackBarBehavior.floating,
        ),
      );
      return;
    }
    try {
      final api = context.read<ApiClient>();
      await api.post('/v1/users/handle', body: {'handle': handle});
      // Only update handle — display name stays independent.
      await auth.setHandle(handle);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Handle set to @$handle'),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(friendlyError(e)),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  Future<void> _pickAvatar(BuildContext context) async {
    final auth = context.read<EvabobAuth>();
    final api = context.read<ApiClient>();
    try {
      final picker = ImagePicker();
      final file = await picker.pickImage(
        source: ImageSource.gallery,
        maxWidth: 512,
        maxHeight: 512,
        imageQuality: 85,
      );
      if (file == null) return;
      final bytes = await file.readAsBytes();
      if (bytes.lengthInBytes > _maxAvatarBytes) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Photo must be 256 KB or smaller'),
              behavior: SnackBarBehavior.floating,
            ),
          );
        }
        return;
      }
      final dir = await getApplicationDocumentsDirectory();
      final dest =
          File(p.join(dir.path, 'avatar_${auth.user?.id ?? 'me'}.jpg'));
      await dest.writeAsBytes(bytes, flush: true);
      await auth.setAvatarPath(dest.path);

      // Upload to server (Mongo / uploads) for cross-device PFP
      try {
        final b64 = base64Encode(bytes);
        final res = await api.post('/v1/users/me/avatar', body: {
          'imageBase64': 'data:image/jpeg;base64,$b64',
          'mime': 'image/jpeg',
        });
        final url = res['avatarUrl']?.toString();
        if (url != null && url.isNotEmpty) {
          await auth.setAvatarUrl(url);
        }
      } catch (e) {
        debugPrint('avatar upload: $e');
      }

      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Profile photo updated'),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text(friendlyError(e)),
              behavior: SnackBarBehavior.floating),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<EvabobAuth>();
    final circle = context.watch<CircleWalletService>();
    final user = auth.user;
    final name = user?.displayName ?? 'Guest';
    final email = user?.email ?? '';
    final wallet = (circle.address != null && circle.address!.isNotEmpty)
        ? circle.address!
        : (user?.smartAccount ?? '');
    final shortWallet = wallet.length > 12
        ? '${wallet.substring(0, 6)}…${wallet.substring(wallet.length - 4)}'
        : wallet;
    return SafeArea(
      child: ListView(
        padding: EdgeInsets.fromLTRB(20, 8, 20, showBack ? 24 : 120),
        children: [
          if (showBack)
            Row(
              children: [
                IconButton(
                  onPressed: onBack,
                  tooltip: 'Back',
                  icon: const Icon(Icons.chevron_left_rounded),
                ),
                const Text(
                  'Profile',
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navy,
                  ),
                ),
              ],
            )
          else
            const Padding(
              padding: EdgeInsets.only(top: 8, bottom: 4),
              child: Text(
                'Profile',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w400,
                  color: EvabobColors.navy,
                ),
              ),
            ),
          const SizedBox(height: 12),
          Glass(
            heavy: true,
            child: Column(
              children: [
                GestureDetector(
                  onTap: () => showAvatarPicker(
                    context,
                    onUpload: () => _pickAvatar(context),
                  ),
                  child: Stack(
                    alignment: Alignment.bottomRight,
                    children: [
                      const UserAvatar(size: 80),
                      Container(
                        padding: const EdgeInsets.all(4),
                        decoration: const BoxDecoration(
                          color: EvabobColors.emerald,
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          Icons.camera_alt_rounded,
                          size: 14,
                          color: EvabobColors.onPrimary,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Tap to change',
                  style: TextStyle(fontSize: 10, color: EvabobColors.chalk),
                ),
                const SizedBox(height: 12),
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navy,
                  ),
                ),
                Text(
                  '@${user?.handleOrFallback ?? '…'}',
                  style: const TextStyle(
                    color: EvabobColors.emeraldDeep,
                    fontWeight: FontWeight.w400,
                    fontSize: 14,
                  ),
                ),
                if (email.isNotEmpty)
                  Text(
                    email,
                    style: const TextStyle(color: EvabobColors.navyMuted),
                  ),
                const SizedBox(height: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                    color: EvabobColors.emerald.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    auth.isDemoMode ? 'Demo account' : 'Signed in',
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w400,
                      color: EvabobColors.emeraldDeep,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Glass(
            child: Column(
              children: [
                _tile(
                  Icons.badge_outlined,
                  'Display name',
                  name,
                  () => _editDisplayName(context, auth),
                ),
                const Divider(height: 1),
                _tile(
                  Icons.alternate_email_rounded,
                  '@handle',
                  '@${user?.handleOrFallback ?? '…'}',
                  () => _editHandle(context, auth),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Glass(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Wallet',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navyMuted,
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        shortWallet.isEmpty ? 'Not linked yet' : shortWallet,
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontWeight: FontWeight.w400,
                          color: EvabobColors.navy,
                        ),
                      ),
                    ),
                    if (wallet.isNotEmpty)
                      IconButton(
                        tooltip: 'Copy address',
                        onPressed: () async {
                          await Clipboard.setData(ClipboardData(text: wallet));
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text('Address copied'),
                                behavior: SnackBarBehavior.floating,
                              ),
                            );
                          }
                        },
                        icon: const Icon(Icons.copy_rounded, size: 18),
                      ),
                  ],
                ),
                Text(
                  'Arc',
                  style: const TextStyle(
                    fontSize: 10,
                    color: EvabobColors.chalk,
                  ),
                ),
              ],
            ),
          ),
          // The light theme is parked while the Dark Mint redesign is the only
          // one built — the toggle would be a no-op, so it is hidden rather
          // than shown broken. `ThemeController` still persists the choice for
          // when a light theme returns.
          const SizedBox(height: 14),
          const SizedBox(height: 14),
          Glass(
            child: Column(
              children: [
                _tile(
                  Icons.verified_user_outlined,
                  'Set up wallet',
                  circle.ready && circle.address != null
                      ? '${circle.address!.substring(0, 8)}… · tap to refresh'
                      : 'Create your spendable account (PIN)',
                  () => openCircleWalletOnboarding(context),
                ),
                Divider(
                    height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
                Builder(
                  builder: (context) {
                    final lock = context.watch<AppLockService>();
                    return _tile(
                      Icons.lock_outline_rounded,
                      'App lock',
                      lock.enabled
                          ? (lock.bioEnabled
                              ? 'PIN + biometrics · tap to change'
                              : 'PIN enabled · tap to change / disable')
                          : 'Require PIN or fingerprint to open app',
                      () async {
                        if (!lock.enabled) {
                          await Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) =>
                                  const AppLockScreen(setupMode: true),
                            ),
                          );
                          return;
                        }
                        final action = await showModalBottomSheet<String>(
                          context: context,
                          builder: (ctx) => SafeArea(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                ListTile(
                                  leading: const Icon(Icons.pin_outlined),
                                  title: const Text('Change app PIN'),
                                  onTap: () => Navigator.pop(ctx, 'change'),
                                ),
                                if (lock.bioAvailable)
                                  ListTile(
                                    leading: const Icon(Icons.fingerprint),
                                    title: Text(
                                      lock.bioEnabled
                                          ? 'Disable biometrics'
                                          : 'Enable biometrics',
                                    ),
                                    onTap: () => Navigator.pop(ctx, 'bio'),
                                  ),
                                ListTile(
                                  leading: const Icon(Icons.lock_open_rounded),
                                  title: const Text('Turn off app lock'),
                                  onTap: () => Navigator.pop(ctx, 'off'),
                                ),
                              ],
                            ),
                          ),
                        );
                        if (!context.mounted || action == null) return;
                        if (action == 'change') {
                          await Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) =>
                                  const AppLockScreen(setupMode: true),
                            ),
                          );
                        } else if (action == 'bio') {
                          await lock.setBiometrics(!lock.bioEnabled);
                        } else if (action == 'off') {
                          await lock.disableLock();
                        }
                      },
                    );
                  },
                ),
                // Confirm payments with fingerprint or Face ID instead of the
                // PIN. Shown only in builds that include Circle's native SDK.
                const _BiometricConfirmTile(),
                Divider(
                    height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
                _tile(
                  Icons.family_restroom_rounded,
                  'Family check',
                  'A code from email before large payments to family',
                  () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const FamilyCheckScreen(),
                    ),
                  ),
                ),
                // Operators only: decide held-payment reviews.
                const _OperatorReviewsTile(),
                // Gateway payment methods parked — revisit later.
                // Divider(height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
                // _tile(
                //   Icons.account_balance_wallet_outlined,
                //   'Payment methods',
                //   'Top up and pay from your GA',
                //   () {
                //     Navigator.of(context).push(
                //       MaterialPageRoute(
                //         builder: (_) => const GatewayScreen(),
                //       ),
                //     );
                //   },
                // ),
                // Agent wallets live in the Home ⋯ menu only.
                Divider(
                    height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
                _tile(
                  Icons.help_outline_rounded,
                  'Get help',
                  'Ask Evabob anything about your money',
                  () {
                    // This tile did nothing at all — its onTap was an empty
                    // function. The assistant is where help actually lives.
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text(
                          'Open Chat and ask Evabob — it can see your balance '
                          'and your payments.',
                        ),
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          PressScale(
            onTap: () async {
              final ok = await confirmAction(
                context,
                title: 'Sign out?',
                message: 'Your money stays where it is. You will need your '
                    'email code to get back in.',
                confirmLabel: 'Sign out',
                destructive: true,
              );
              if (ok) await auth.signOut();
            },
            child: Container(
              height: 50,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(999),
                border: Border.all(
                  color: EvabobColors.danger.withValues(alpha: 0.4),
                ),
              ),
              child: const Text(
                'Sign out',
                style: TextStyle(
                  color: EvabobColors.danger,
                  fontWeight: FontWeight.w400,
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          const Text(
            'Evabob',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 10, color: EvabobColors.chalk),
          ),
        ],
      ),
    );
  }

  Widget _tile(
    IconData icon,
    String title,
    String subtitle,
    VoidCallback onTap,
  ) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: EvabobColors.emeraldDeep),
      title: Text(
        title,
        style: const TextStyle(
          fontWeight: FontWeight.w400,
          color: EvabobColors.navy,
        ),
      ),
      subtitle: Text(
        subtitle,
        style: const TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
      ),
      trailing:
          const Icon(Icons.chevron_right_rounded, color: EvabobColors.chalk),
      onTap: onTap,
    );
  }
}

/// Shown only to operators. Asks the server once whether this account may
/// decide held-payment reviews, and renders nothing for everyone else.
class _OperatorReviewsTile extends StatefulWidget {
  const _OperatorReviewsTile();

  @override
  State<_OperatorReviewsTile> createState() => _OperatorReviewsTileState();
}

class _OperatorReviewsTileState extends State<_OperatorReviewsTile> {
  bool _operator = false;

  @override
  void initState() {
    super.initState();
    OperatorReviewsApi(context.read<ApiClient>()).isOperator().then((v) {
      if (mounted && v) setState(() => _operator = true);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_operator) return const SizedBox.shrink();
    return Column(
      children: [
        Divider(height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.gavel_rounded,
              color: EvabobColors.emeraldDeep),
          title: const Text(
            'Held-payment reviews',
            style: TextStyle(
              fontWeight: FontWeight.w400,
              color: EvabobColors.navy,
            ),
          ),
          subtitle: const Text(
            'Jobs cancelled after delivery, waiting for a decision',
            style: TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
          ),
          trailing: const Icon(Icons.chevron_right_rounded,
              color: EvabobColors.chalk),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => const OperatorReviewsScreen(),
            ),
          ),
        ),
      ],
    );
  }
}

class _BiometricConfirmTile extends StatefulWidget {
  const _BiometricConfirmTile();

  @override
  State<_BiometricConfirmTile> createState() => _BiometricConfirmTileState();
}

class _BiometricConfirmTileState extends State<_BiometricConfirmTile> {
  bool? _available;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    CircleNativeSdk.available().then((v) {
      if (mounted) setState(() => _available = v);
    });
  }

  Future<void> _toggle(bool on) async {
    setState(() => _busy = true);
    final error =
        await context.read<CircleWalletService>().setBiometricConfirm(context, on);
    if (!mounted) return;
    setState(() => _busy = false);
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error), behavior: SnackBarBehavior.floating),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_available != true) return const SizedBox.shrink();
    final on = context.watch<CircleWalletService>().biometricConfirm;
    return Column(
      children: [
        Divider(height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: on,
          onChanged: _busy ? null : _toggle,
          secondary: const Icon(Icons.fingerprint_rounded,
              color: EvabobColors.emeraldDeep),
          title: const Text(
            'Confirm with fingerprint or Face ID',
            style: TextStyle(
              fontWeight: FontWeight.w400,
              color: EvabobColors.navy,
            ),
          ),
          subtitle: Text(
            on
                ? 'Payments ask for your fingerprint or face. Your PIN still works.'
                : 'Instead of typing your PIN each time. You set it up once with your PIN.',
            style: const TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
          ),
        ),
      ],
    );
  }
}
