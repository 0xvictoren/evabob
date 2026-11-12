import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/market/market_api.dart';
import '../../core/platform/browser.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/top_snack.dart';

/// Operators only: outside accounts (Instagram, X, TikTok, Facebook,
/// WhatsApp) that sellers say are theirs.
///
/// Those sites do not let software read a profile, so a person opens the
/// account, looks for the seller's code in the bio, and says whether it is
/// there. Reachable from Profile for operators and from the notification
/// sent when someone asks for a check.
class MarketChecksScreen extends StatefulWidget {
  const MarketChecksScreen({super.key});

  @override
  State<MarketChecksScreen> createState() => _MarketChecksScreenState();
}

class _MarketChecksScreenState extends State<MarketChecksScreen> {
  late final MarketApi _api = MarketApi(context.read<ApiClient>());
  List<Map<String, dynamic>>? _items;
  String? _error;
  String? _deciding;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _say(String text) => showTopSnack(
        context,
        SnackBar(content: Text(text), behavior: SnackBarBehavior.floating),
      );

  Future<void> _load() async {
    try {
      final items = await _api.socialChecks();
      if (mounted) setState(() => (_items = items, _error = null));
    } catch (e) {
      if (mounted) {
        setState(() => _error = friendlyError(
              e,
              fallback: 'Could not load the checks. Pull down to try again.',
            ));
      }
    }
  }

  static String _key(Map<String, dynamic> c) => '${c['userId']}:${c['platform']}';

  /// In a browser the account opens in a new tab; on a phone the link is
  /// copied, to paste into the browser or the app it belongs to.
  Future<void> _openAccount(Map<String, dynamic> c) async {
    final url = c['url']?.toString() ?? '';
    if (url.isEmpty) return;
    if (kIsWeb) {
      Browser.openTab(url);
      return;
    }
    await Clipboard.setData(ClipboardData(text: url));
    if (mounted) _say('Link copied. Paste it into your browser.');
  }

  Future<void> _decide(Map<String, dynamic> c, bool verified) async {
    final name = _platformName(c['platform']?.toString() ?? '');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(verified ? 'Confirm this account?' : 'Code not there?'),
        content: Text(
          verified
              ? 'You saw ${c['code']} on the $name account ${c['handle']}. '
                  'It will show as checked on the seller\'s profile and add '
                  'to their reputation.'
              : 'The seller is told the code was not found on ${c['handle']} '
                  'and can ask again after adding it.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Back'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(verified ? 'Yes, it is there' : 'Not found'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() => _deciding = _key(c));
    try {
      await _api.decideSocialCheck(
        userId: c['userId']?.toString() ?? '',
        platform: c['platform']?.toString() ?? '',
        verified: verified,
      );
      if (!mounted) return;
      _say(verified ? 'Marked as checked.' : 'Marked as not found.');
      await _load();
    } catch (e) {
      if (mounted) _say(friendlyError(e));
    } finally {
      if (mounted) setState(() => _deciding = null);
    }
  }

  static String _platformName(String id) => switch (id) {
        'instagram' => 'Instagram',
        'x' => 'X',
        'tiktok' => 'TikTok',
        'facebook' => 'Facebook',
        'whatsapp' => 'WhatsApp',
        'website' => 'Website',
        _ => id,
      };

  static IconData _platformIcon(String id) => switch (id) {
        'instagram' => Icons.camera_alt_outlined,
        'x' => Icons.alternate_email_rounded,
        'tiktok' => Icons.music_note_rounded,
        'facebook' => Icons.facebook_rounded,
        'whatsapp' => Icons.chat_outlined,
        _ => Icons.language_rounded,
      };

  static String _asked(Object? iso) {
    final t = DateTime.tryParse(iso?.toString() ?? '');
    return t == null
        ? ''
        : 'Asked ${DateFormat('EEE d MMM, HH:mm').format(t.toLocal())}';
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.page),
              child: EvabobPageHeader(
                title: 'Account checks',
                onBack: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(
                      Space.page, 0, Space.page, Space.xl),
                  children: [
                    Text(
                      'Sellers who say an outside account is theirs. Open the '
                      'account, look for their code in the bio, then say '
                      'whether it is there.',
                      style: Type.caption.copyWith(color: EvabobColors.inkMuted),
                    ),
                    const SizedBox(height: Space.md),
                    if (items == null && _error == null)
                      const Padding(
                        padding: EdgeInsets.only(top: 60),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                    if (_error != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 60),
                        child: Text(_error!, textAlign: TextAlign.center),
                      ),
                    if (items != null && items.isEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 60),
                        child: Text(
                          'No accounts waiting to be checked.',
                          textAlign: TextAlign.center,
                          style:
                              Type.body.copyWith(color: EvabobColors.inkMuted),
                        ),
                      ),
                    for (final c in items ?? const <Map<String, dynamic>>[])
                      Padding(
                        padding: const EdgeInsets.only(bottom: Space.sm),
                        child: _CheckCard(
                          check: c,
                          platformName:
                              _platformName(c['platform']?.toString() ?? ''),
                          icon: _platformIcon(c['platform']?.toString() ?? ''),
                          asked: _asked(c['requestedAt']),
                          busy: _deciding == _key(c),
                          onOpen: () => _openAccount(c),
                          onFound: () => _decide(c, true),
                          onMissing: () => _decide(c, false),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CheckCard extends StatelessWidget {
  const _CheckCard({
    required this.check,
    required this.platformName,
    required this.icon,
    required this.asked,
    required this.busy,
    required this.onOpen,
    required this.onFound,
    required this.onMissing,
  });

  final Map<String, dynamic> check;
  final String platformName;
  final IconData icon;
  final String asked;
  final bool busy;
  final VoidCallback onOpen;
  final VoidCallback onFound;
  final VoidCallback onMissing;

  @override
  Widget build(BuildContext context) {
    final owner = check['owner'] == null ? 'A seller' : '@${check['owner']}';
    return Glass(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(icon, size: 20, color: EvabobColors.primary),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '$platformName · ${check['handle'] ?? ''}',
                      style: Type.body.copyWith(color: EvabobColors.ink),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [owner, if (asked.isNotEmpty) asked].join(' · '),
                      style:
                          Type.label.copyWith(color: EvabobColors.inkMuted),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: Space.md),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: EvabobColors.pageBg,
              borderRadius: Radii.all(12),
            ),
            child: Row(
              children: [
                Text('Code to look for',
                    style: Type.label.copyWith(color: EvabobColors.inkMuted)),
                const Spacer(),
                SelectableText(
                  check['code']?.toString() ?? '—',
                  style: Type.body.copyWith(color: EvabobColors.ink),
                ),
              ],
            ),
          ),
          const SizedBox(height: Space.sm),
          PressScale(
            onTap: onOpen,
            child: Container(
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: EvabobColors.primary.withValues(alpha: 0.08),
                borderRadius: Radii.all(Radii.pill),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(kIsWeb ? Icons.open_in_new_rounded : Icons.copy_rounded,
                      size: 16, color: EvabobColors.primary),
                  const SizedBox(width: 8),
                  Text(
                    kIsWeb ? 'Open the account' : 'Copy the account link',
                    style: Type.body.copyWith(color: EvabobColors.primary),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: Space.sm),
          if (busy)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 10),
              child: Center(
                child: SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            )
          else
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: onMissing,
                    child: const Text('Not there'),
                  ),
                ),
                const SizedBox(width: Space.sm),
                Expanded(
                  child: FilledButton(
                    onPressed: onFound,
                    child: const Text('Code is there'),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}
