import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/top_snack.dart';
import 'market_post_screen.dart';
import 'market_widgets.dart';

/// A person's page on the market: who they are, their record, their
/// Instagram, X, TikTok, Facebook and other accounts, and everything they
/// have for sale, shelf by shelf.
class MarketProfileScreen extends StatefulWidget {
  const MarketProfileScreen({super.key, required this.person});

  /// A user id or an @handle.
  final String person;

  @override
  State<MarketProfileScreen> createState() => _MarketProfileScreenState();
}

class _MarketProfileScreenState extends State<MarketProfileScreen> {
  late final MarketApi _api = MarketApi(context.read<ApiClient>());
  Map<String, dynamic>? _data;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await _api.person(widget.person);
      if (mounted) setState(() => (_data = data, _error = null));
    } catch (e) {
      if (mounted) setState(() => _error = friendlyError(e));
    }
  }

  void _copySocial(String url) {
    if (url.isEmpty) return;
    Clipboard.setData(ClipboardData(text: url));
    showTopSnack(
      context,
      const SnackBar(
        content: Text('Link copied. Open it in your browser to see their page.'),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  Future<void> _open(MarketPost post) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => MarketPostScreen(postId: post.id)),
    );
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final person = data?['person'] is Map
        ? Map<String, dynamic>.from(data!['person'] as Map)
        : null;
    final shelves = [
      for (final s in (data?['shelves'] as List?) ?? const [])
        if (s is Map)
          (
            id: s['id']?.toString() ?? 'other',
            label: s['label']?.toString() ?? '',
            items: [
              for (final p in (s['items'] as List?) ?? const [])
                if (p is Map) MarketPost.fromJson(Map<String, dynamic>.from(p)),
            ],
          ),
    ];
    final total = shelves.fold<int>(0, (n, s) => n + s.items.length);
    return Scaffold(
      backgroundColor: EvabobColors.pageBg,
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding:
                const EdgeInsets.fromLTRB(Space.page, 0, Space.page, Space.xxl),
            children: [
              EvabobPageHeader(
                title: 'Seller',
                onBack: () => Navigator.of(context).maybePop(),
              ),
              if (person == null)
                Padding(
                  padding: const EdgeInsets.only(top: 80),
                  child: Center(
                    child: _error != null
                        ? Text(_error!, textAlign: TextAlign.center)
                        : const CircularProgressIndicator(),
                  ),
                )
              else ...[
                SellerCard(person: person, onCopySocial: _copySocial),
                const SizedBox(height: Space.lg),
                EvabobSectionLabel('For sale ($total)'),
                const SizedBox(height: Space.sm),
                if (total == 0)
                  Text(
                    'Nothing for sale right now.',
                    style: Type.label.copyWith(color: EvabobColors.inkMuted),
                  ),
                for (final shelf in shelves) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: Space.sm, bottom: 6),
                    child: Row(
                      children: [
                        Icon(marketCategoryIcon(shelf.id),
                            size: 16, color: EvabobColors.emeraldDeep),
                        const SizedBox(width: 6),
                        Text(
                          '${shelf.label} (${shelf.items.length})',
                          style: Type.body
                              .copyWith(color: EvabobColors.emeraldDeep),
                        ),
                      ],
                    ),
                  ),
                  for (final p in shelf.items) ...[
                    MarketPostTile(post: p, onTap: () => _open(p)),
                    const SizedBox(height: Space.sm),
                  ],
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }
}
