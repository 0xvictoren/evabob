import 'dart:convert';
import 'web_page_screen.dart';
import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/fx/fx_service.dart';
import '../../core/platform/browser.dart';
import '../../core/api/api_client.dart';
import '../../core/held/operator_reviews_api.dart';
import '../../core/notifications/money_alerts.dart';
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
import '../chat/chat_list_screen.dart';
import '../held/operator_reviews_screen.dart';
import 'account_statement_pdf.dart';
import 'family_check_screen.dart';
// Gateway parked for later.
// import '../gateway/gateway_screen.dart';
import '../wallet/circle_onboard_sheet.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';
import '../../core/theme/theme_controller.dart';

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
          showTopSnack(
            context,
            SnackBar(
              content: Text(friendlyError(e)),
              behavior: SnackBarBehavior.floating,
            ),
          );
        }
        return;
      }
      if (context.mounted) {
        showTopSnack(
          context,
          const SnackBar(
            content: Text('Display name updated'),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    }
  }

  /// The @handle is chosen once at signup and is permanent: people who have
  /// paid it before must always reach the same person. Profile shows it; it
  /// never edits it.
  Future<void> _showHandle(BuildContext context, EvabobAuth auth) {
    final handle = auth.user?.handleOrFallback ?? '';
    return _showProfileSheet(
      context,
      icon: Icons.alternate_email_rounded,
      title: '@$handle',
      body:
          'This is how people find and pay you. It was chosen when you signed up and is permanent, so anyone who has paid you before always reaches you.',
      footnote: 'Your display name and photo can still be changed.',
      primaryLabel: 'Done',
    );
  }

  /// Terms and Privacy are the published pages on evabob.xyz, opened inside
  /// the app.
  Future<void> _showTerms(BuildContext context) =>
      WebPageScreen.open(context, 'Terms', WebPageScreen.termsUrl);

  Future<void> _showPrivacy(BuildContext context) =>
      WebPageScreen.open(context, 'Privacy', WebPageScreen.privacyUrl);

  /// Export as a PDF to read (activity, contacts) or as JSON, the complete
  /// copy of everything the account holds.
  Future<void> _exportAccount(BuildContext context) async {
    final format = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: EvabobColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 16, 8, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.picture_as_pdf_outlined),
                title: const Text('PDF'),
                subtitle: const Text(
                    'Easy to read: your account, payments and contacts'),
                onTap: () => Navigator.pop(sheetContext, 'pdf'),
              ),
              ListTile(
                leading: const Icon(Icons.data_object_rounded),
                title: const Text('JSON'),
                subtitle: const Text('Everything, for another app to read'),
                onTap: () => Navigator.pop(sheetContext, 'json'),
              ),
            ],
          ),
        ),
      ),
    );
    if (format == null || !context.mounted) return;
    try {
      final data = await context.read<ApiClient>().get('/v1/users/me/export');
      final stamp = DateTime.now().millisecondsSinceEpoch;
      final pdf = format == 'pdf';
      final Uint8List bytes = pdf
          ? await buildAccountStatementPdf(data)
          : Uint8List.fromList(
              utf8.encode(const JsonEncoder.withIndent('  ').convert(data)));
      final name = 'evabob-export-$stamp.${pdf ? 'pdf' : 'json'}';
      final mime = pdf ? 'application/pdf' : 'application/json';
      if (kIsWeb) {
        Browser.download(bytes, name, mime);
        return;
      }
      final dir = await getTemporaryDirectory();
      final path = p.join(dir.path, name);
      await File(path).writeAsBytes(bytes, flush: true);
      await SharePlus.instance.share(
        ShareParams(
          subject: 'Your Evabob data export',
          files: [XFile(path, mimeType: mime)],
        ),
      );
    } catch (error) {
      if (!context.mounted) return;
      showTopSnack(
        context,
        SnackBar(
          content: Text(
            error is ApiException && error.status == 403
                ? 'For security, sign out and sign in again before exporting.'
                : friendlyError(error),
          ),
        ),
      );
    }
  }

  Future<void> _showHelp(BuildContext context) {
    return _showProfileSheet(
      context,
      icon: Icons.chat_bubble_outline_rounded,
      title: 'Get help',
      body:
          'Ask Evabob about a payment, your balance, moving money, or anything that looks unfamiliar.',
      footnote:
          'For account recovery or a lost phone, contact support from a device you still control.',
      primaryLabel: 'Open Chat',
      onPrimary: () {
        Navigator.of(context).pop();
        Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const ChatListScreen()),
        );
      },
    );
  }

  Future<void> _showDeleteAccount(BuildContext context) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: EvabobColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: EvabobColors.hairline,
                  borderRadius: BorderRadius.circular(99),
                ),
              ),
              const SizedBox(height: 28),
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: EvabobColors.alert.withValues(alpha: .1),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.delete_outline_rounded,
                  color: EvabobColors.alert,
                  size: 28,
                ),
              ),
              const SizedBox(height: 20),
              const Text(
                'Delete your account?',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontFamily: 'Numans',
                  fontSize: 24,
                  height: 32 / 24,
                  letterSpacing: -.4,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Your profile, chats and Evabob history will be removed, and you will not be able to sign in again. Send out any money in your wallet first: once the account is deleted you cannot reach it from Evabob.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 14,
                  height: 18 / 14,
                  color: EvabobColors.inkMuted,
                ),
              ),
              const SizedBox(height: 28),
              SizedBox(
                width: double.infinity,
                height: 56,
                child: FilledButton(
                  onPressed: () async {
                    try {
                      await context.read<ApiClient>().delete(
                        '/v1/users/me',
                        body: {'confirm': 'DELETE'},
                      );
                      if (!context.mounted) return;
                      Navigator.pop(sheetContext);
                      await context.read<EvabobAuth>().signOut();
                    } catch (error) {
                      if (!sheetContext.mounted) return;
                      Navigator.pop(sheetContext);
                      if (!context.mounted) return;
                      showTopSnack(
                        context,
                        SnackBar(
                          content: Text(
                            error is ApiException && error.status == 403
                                ? 'For security, sign out and sign in again before deleting.'
                                : friendlyError(error),
                          ),
                        ),
                      );
                    }
                  },
                  style: FilledButton.styleFrom(
                    backgroundColor: EvabobColors.alert,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: const Text('Delete my account'),
                ),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: () => Navigator.pop(sheetContext),
                child: const Text('Keep my account'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _showProfileSheet(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String body,
    required String footnote,
    required String primaryLabel,
    VoidCallback? onPrimary,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: EvabobColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (sheetContext) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Align(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: EvabobColors.hairline,
                    borderRadius: BorderRadius.circular(99),
                  ),
                ),
              ),
              const SizedBox(height: 28),
              Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: EvabobColors.blueSoft,
                  shape: BoxShape.circle,
                ),
                child: Icon(icon, color: EvabobColors.ink, size: 28),
              ),
              const SizedBox(height: 20),
              Text(
                title,
                style: const TextStyle(
                  fontFamily: 'Numans',
                  fontSize: 24,
                  height: 32 / 24,
                  letterSpacing: -.4,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                body,
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 14,
                  height: 20 / 14,
                  color: EvabobColors.ink,
                ),
              ),
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: EvabobColors.pageBg,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  footnote,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    height: 16 / 12,
                    color: EvabobColors.inkMuted,
                  ),
                ),
              ),
              const SizedBox(height: 24),
              SizedBox(
                height: 56,
                child: FilledButton(
                  onPressed: onPrimary ?? () => Navigator.pop(sheetContext),
                  style: FilledButton.styleFrom(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                  ),
                  child: Text(primaryLabel),
                ),
              ),
            ],
          ),
        ),
      ),
    );
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
          showTopSnack(
            context,
            const SnackBar(
              content: Text('Photo must be 256 KB or smaller'),
              behavior: SnackBarBehavior.floating,
            ),
          );
        }
        return;
      }
      // The web-app has no local copy; it shows the uploaded URL below.
      if (!kIsWeb) {
        final dir = await getApplicationDocumentsDirectory();
        final dest =
            File(p.join(dir.path, 'avatar_${auth.user?.id ?? 'me'}.jpg'));
        await dest.writeAsBytes(bytes, flush: true);
        await auth.setAvatarPath(dest.path);
      }

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
        showTopSnack(
          context,
          const SnackBar(
            content: Text('Profile photo updated'),
            behavior: SnackBarBehavior.floating,
          ),
        );
      }
    } catch (e) {
      if (context.mounted) {
        showTopSnack(
          context,
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
                        decoration: BoxDecoration(
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
                  style: TextStyle(
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
                    style: TextStyle(
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
                  'Edit profile',
                  'Name, photo, and account details',
                  () => _editDisplayName(context, auth),
                ),
                const Divider(height: 1),
                _tile(
                  Icons.alternate_email_rounded,
                  '@handle',
                  '@${user?.handleOrFallback ?? '…'}',
                  () => _showHandle(context, auth),
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
                            showTopSnack(
                              context,
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
                    final fx = context.watch<FxService>();
                    return _tile(
                      Icons.currency_exchange_rounded,
                      'Main currency',
                      fx.isNaira
                          ? 'Naira (₦) · amounts shown and typed in naira'
                          : r'Dollar ($) · amounts shown and typed in dollars',
                      () => _pickCurrency(context),
                    );
                  },
                ),
                Divider(
                    height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
                Builder(
                  builder: (context) {
                    final theme = context.watch<ThemeController>();
                    return _tile(
                      Icons.palette_outlined,
                      'App theme',
                      theme.palette.label,
                      () => _pickTheme(context),
                    );
                  },
                ),
                // The web-app signs out when the tab closes, so it has no
                // app lock (and no fingerprint or Face ID to offer).
                if (!kIsWeb) ...[
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
                ],
                // Confirm payments with fingerprint or Face ID instead of the
                // PIN. Shown only in builds that include Circle's native SDK.
                const _BiometricConfirmTile(),
                const _NotificationDetailsTile(),
                const _ExternalAiTile(),
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
                //   'Top up and pay from your Gateway Account',
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
                  Icons.description_outlined,
                  'Terms',
                  'How Evabob and payments work',
                  () => _showTerms(context),
                ),
                Divider(
                    height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
                _tile(
                  Icons.privacy_tip_outlined,
                  'Privacy',
                  'What is collected, retained, and shared',
                  () => _showPrivacy(context),
                ),
                Divider(
                    height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
                _tile(
                  Icons.download_outlined,
                  'Export my data',
                  'Create a private JSON copy of your account data',
                  () => _exportAccount(context),
                ),
                Divider(
                    height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
                _tile(
                  Icons.help_outline_rounded,
                  'Get help',
                  'Ask Evabob anything about your money',
                  () => _showHelp(context),
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
          TextButton(
            onPressed: () => _showDeleteAccount(context),
            style: TextButton.styleFrom(
              foregroundColor: EvabobColors.alert,
              minimumSize: const Size.fromHeight(48),
            ),
            child: const Text('Delete account'),
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

  /// Naira or dollars: every amount in the app is shown and typed in the
  /// one chosen, with the other underneath. Saved to the account, so it
  /// follows the person to another phone.
  Future<void> _pickCurrency(BuildContext context) async {
    final fx = context.read<FxService>();
    final api = context.read<ApiClient>();
    final picked = await showModalBottomSheet<DominantCurrency>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final c in DominantCurrency.values)
              ListTile(
                leading: Text(
                  c.symbol,
                  style:
                      const TextStyle(fontSize: 20, color: EvabobColors.navy),
                ),
                title: Text(c == DominantCurrency.ngn ? 'Naira' : 'Dollar'),
                subtitle: Text(
                  c == DominantCurrency.ngn
                      ? r'Type ₦2,000 and the dollar amount is sent'
                      : r'Amounts in dollars, naira underneath',
                ),
                trailing: fx.dominant == c
                    ? Icon(Icons.check_rounded, color: EvabobColors.blue)
                    : null,
                onTap: () => Navigator.pop(ctx, c),
              ),
          ],
        ),
      ),
    );
    if (picked == null || picked == fx.dominant) return;
    await fx.setDominant(picked);
    try {
      await api.post('/v1/users/me/currency', body: {'currency': picked.code});
    } catch (_) {
      // Kept on this phone; it is saved to the account next time.
    }
  }

  /// Blue, pink or grey: the colour of buttons, links and backgrounds
  /// across the app. Kept on this phone.
  Future<void> _pickTheme(BuildContext context) async {
    final theme = context.read<ThemeController>();
    final picked = await showModalBottomSheet<EvabobPalette>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final p in EvabobPalette.values)
              ListTile(
                leading: _PaletteSwatch(palette: p),
                title: Text(p.label),
                trailing: theme.palette == p
                    ? Icon(Icons.check_rounded, color: EvabobColors.blue)
                    : null,
                onTap: () => Navigator.pop(ctx, p),
              ),
          ],
        ),
      ),
    );
    if (picked == null) return;
    await theme.setPalette(picked);
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
          leading: Icon(Icons.gavel_rounded, color: EvabobColors.emeraldDeep),
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
    final error = await context
        .read<CircleWalletService>()
        .setBiometricConfirm(context, on);
    if (!mounted) return;
    setState(() => _busy = false);
    if (error != null) {
      showTopSnack(
        context,
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
          secondary:
              Icon(Icons.fingerprint_rounded, color: EvabobColors.emeraldDeep),
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

/// Notifications say who and how much by default. This switch makes them say
/// only "You have a new private update." — on this phone, and in pushes the
/// server sends while the app is closed.
class _NotificationDetailsTile extends StatefulWidget {
  const _NotificationDetailsTile();

  @override
  State<_NotificationDetailsTile> createState() =>
      _NotificationDetailsTileState();
}

class _NotificationDetailsTileState extends State<_NotificationDetailsTile> {
  late bool _hidden = context.read<MoneyAlerts>().hideDetails;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // The account's choice wins: it may have been made on another phone.
    context.read<ApiClient>().get('/v1/users/me').then((response) {
      final user = response['user'];
      if (!mounted || user is! Map) return;
      final hidden = user['hideNotificationDetails'] == true;
      if (hidden != _hidden) {
        context.read<MoneyAlerts>().setHideDetails(hidden);
        setState(() => _hidden = hidden);
      }
    }).catchError((_) {});
  }

  Future<void> _toggle(bool hide) async {
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().post(
        '/v1/users/me',
        body: {'hideNotificationDetails': hide},
      );
      if (!mounted) return;
      await context.read<MoneyAlerts>().setHideDetails(hide);
      if (mounted) setState(() => _hidden = hide);
    } catch (error) {
      if (mounted) {
        showTopSnack(context, SnackBar(content: Text(friendlyError(error))));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Divider(height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          value: _hidden,
          onChanged: _busy ? null : _toggle,
          secondary: Icon(
            Icons.notifications_off_outlined,
            color: EvabobColors.emeraldDeep,
          ),
          title: const Text('Hide notification details'),
          subtitle: Text(
            _hidden
                ? 'Notifications only say you have a new private update.'
                : 'Notifications show who paid and how much.',
            style: const TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
          ),
        ),
      ],
    );
  }
}

class _ExternalAiTile extends StatefulWidget {
  const _ExternalAiTile();

  @override
  State<_ExternalAiTile> createState() => _ExternalAiTileState();
}

class _ExternalAiTileState extends State<_ExternalAiTile> {
  bool _enabled = false;
  bool _busy = true;

  @override
  void initState() {
    super.initState();
    context.read<ApiClient>().get('/v1/users/me').then((response) {
      final user = response['user'];
      if (!mounted) return;
      setState(() {
        _enabled = user is Map && user['aiOptOut'] == false;
        _busy = false;
      });
    }).catchError((_) {
      if (mounted) setState(() => _busy = false);
    });
  }

  Future<void> _toggle(bool value) async {
    setState(() => _busy = true);
    try {
      await context.read<ApiClient>().post(
        '/v1/users/me/ai-preference',
        body: {'externalAi': value},
      );
      if (mounted) setState(() => _enabled = value);
    } catch (error) {
      if (mounted) {
        showTopSnack(context, SnackBar(content: Text(friendlyError(error))));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Divider(height: 1, color: EvabobColors.sand.withValues(alpha: 0.8)),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          value: _enabled,
          onChanged: _busy ? null : _toggle,
          secondary: Icon(
            Icons.auto_awesome_outlined,
            color: EvabobColors.emeraldDeep,
          ),
          title: const Text('External AI assistant'),
          subtitle: const Text(
            'Off by default. Core wallet and payment features still work.',
            style: TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
          ),
        ),
      ],
    );
  }
}

/// The three tones of a colour theme, overlapping: base, light-dark, light.
class _PaletteSwatch extends StatelessWidget {
  const _PaletteSwatch({required this.palette});

  final EvabobPalette palette;

  @override
  Widget build(BuildContext context) {
    Widget dot(Color color) => Container(
          width: 20,
          height: 20,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            border: Border.all(color: EvabobColors.white, width: 2),
          ),
        );
    return SizedBox(
      width: 48,
      height: 20,
      child: Stack(
        children: [
          Positioned(left: 24, child: dot(palette.light)),
          Positioned(left: 12, child: dot(palette.lightDark)),
          Positioned(left: 0, child: dot(palette.base)),
        ],
      ),
    );
  }
}
