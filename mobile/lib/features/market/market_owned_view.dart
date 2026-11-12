import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/fx/fx_service.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/evabob_ui.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';
import '../../core/widgets/top_snack.dart';
import 'market_mine_screen.dart';
import 'market_post_screen.dart';
import 'market_widgets.dart';

/// "Owned": everything of the person's on the market, in one place.
///
///   Listed    what they sell — live, not live or sold out — with a switch
///             to take each one off the market and put it back
///   Requests  what they asked for
///   Bought    what they paid for, each with its rating (only a buyer can
///             rate a product, once per purchase)
///
/// A closed post disappears from the market for everyone else but stays
/// here, so it can be opened again.
class MarketOwnedView extends StatefulWidget {
  const MarketOwnedView({super.key, required this.api, required this.onSell});

  final MarketApi api;

  /// Starts a new "for sale" post.
  final VoidCallback onSell;

  @override
  State<MarketOwnedView> createState() => MarketOwnedViewState();
}

class MarketOwnedViewState extends State<MarketOwnedView> {
  List<MarketPost>? _posts;
  List<({MarketDeal deal, MarketPost? post})> _bought = const [];
  String? _error;
  String? _switching;

  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() async {
    try {
      final mine = await widget.api.mine();
      final bought = await widget.api.bought();
      if (!mounted) return;
      setState(() {
        _posts = mine.posts;
        _bought = bought;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _posts ??= const [];
        _error = friendlyError(e);
      });
    }
  }

  void _say(String text) => showTopSnack(
        context,
        SnackBar(content: Text(text), behavior: SnackBarBehavior.floating),
      );

  Future<void> _open(String postId) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => MarketPostScreen(postId: postId)),
    );
    if (mounted) reload();
  }

  Future<void> _setLive(MarketPost post, bool live) async {
    if (_switching != null) return;
    setState(() => _switching = post.id);
    try {
      await widget.api.setActive(post.id, live);
      if (mounted) {
        _say(live
            ? 'It is live. Everyone on the market can see it.'
            : 'Taken off the market. It stays here for you to open again.');
      }
      await reload();
    } catch (e) {
      if (mounted) _say(friendlyError(e));
    } finally {
      if (mounted) setState(() => _switching = null);
    }
  }

  Future<void> _rate(MarketDeal deal) async {
    final done =
        await MarketReviewSheet.show(context, api: widget.api, deal: deal);
    if (done && mounted) {
      _say('Thank you. Your rating is on the product now.');
      reload();
    }
  }

  @override
  Widget build(BuildContext context) {
    final posts = _posts;
    if (posts == null) {
      return const Padding(
        padding: EdgeInsets.only(top: 80),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    final selling = posts.where((p) => !p.isWant).toList();
    final asking = posts.where((p) => p.isWant).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.page, Space.xs, Space.page, 96),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: Space.md),
              child: Text(_error!,
                  style: Type.label.copyWith(color: EvabobColors.alert)),
            ),
          Row(
            children: [
              Expanded(
                child: _Shortcut(
                  icon: Icons.person_outline_rounded,
                  label: 'Your profile',
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          const MarketMineScreen(startOnProfile: true),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: Space.sm),
              Expanded(
                child: _Shortcut(
                  icon: Icons.receipt_long_outlined,
                  label: 'Orders and deals',
                  onTap: () => Navigator.of(context)
                      .push(MaterialPageRoute<void>(
                          builder: (_) => const MarketMineScreen()))
                      .then((_) => mounted ? reload() : null),
                ),
              ),
            ],
          ),
          const SizedBox(height: Space.lg),
          EvabobSectionLabel('Listed for sale (${selling.length})'),
          const SizedBox(height: Space.sm),
          if (selling.isEmpty)
            _EmptyNote(
              text: 'Nothing listed yet. What you sell appears here, where '
                  'you can take it off the market and put it back.',
              action: 'Sell something',
              onTap: widget.onSell,
            ),
          for (var i = 0; i < selling.length; i++) ...[
            RiseIn(
              index: i,
              child: _ListedTile(
                post: selling[i],
                busy: _switching == selling[i].id,
                onTap: () => _open(selling[i].id),
                onLive: (v) => _setLive(selling[i], v),
              ),
            ),
            const SizedBox(height: Space.sm),
          ],
          const SizedBox(height: Space.lg),
          EvabobSectionLabel('Bought (${_bought.length})'),
          const SizedBox(height: Space.sm),
          if (_bought.isEmpty)
            const _EmptyNote(
              text: 'What you pay for on the market appears here. Only '
                  'people who bought a product can rate it.',
            ),
          for (final b in _bought) ...[
            _BoughtTile(
              deal: b.deal,
              post: b.post,
              onTap: () => _open(b.deal.postId),
              onRate: b.deal.canReview ? () => _rate(b.deal) : null,
            ),
            const SizedBox(height: Space.sm),
          ],
          if (asking.isNotEmpty) ...[
            const SizedBox(height: Space.lg),
            EvabobSectionLabel('Your requests (${asking.length})'),
            const SizedBox(height: Space.sm),
            for (final p in asking) ...[
              _ListedTile(
                post: p,
                busy: _switching == p.id,
                onTap: () => _open(p.id),
                onLive: (v) => _setLive(p, v),
              ),
              const SizedBox(height: Space.sm),
            ],
          ],
        ],
      ),
    );
  }
}

class _Shortcut extends StatelessWidget {
  const _Shortcut({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return PressScale(
      onTap: onTap,
      child: Container(
        height: 48,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: EvabobColors.sheet,
          borderRadius: Radii.all(Radii.pill),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 18, color: EvabobColors.primary),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Type.body.copyWith(color: EvabobColors.ink),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyNote extends StatelessWidget {
  const _EmptyNote({required this.text, this.action, this.onTap});

  final String text;
  final String? action;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Glass(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text, style: Type.label.copyWith(color: EvabobColors.inkMuted)),
          if (action != null) ...[
            const SizedBox(height: Space.sm),
            TextButton(onPressed: onTap, child: Text(action!)),
          ],
        ],
      ),
    );
  }
}

/// One of the person's own posts, with the switch that puts it on or takes
/// it off the market.
class _ListedTile extends StatelessWidget {
  const _ListedTile({
    required this.post,
    required this.busy,
    required this.onTap,
    required this.onLive,
  });

  final MarketPost post;
  final bool busy;
  final VoidCallback onTap;
  final ValueChanged<bool> onLive;

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    final state = !post.active
        ? 'Not live'
        : post.soldOut
            ? 'Sold out'
            : 'Live';
    final facts = [
      fx.primary(post.priceUsd),
      if (!post.isWant && post.stockLabel.isNotEmpty && !post.soldOut)
        post.stockLabel,
      if (post.sold > 0) '${post.sold} sold',
      if (post.installments) 'Part payments',
    ].join(' · ');
    return PressScale(
      onTap: onTap,
      scale: 0.98,
      child: Glass(
        child: Row(
          children: [
            MarketThumb(post: post, size: 52),
            const SizedBox(width: Space.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    post.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.body.copyWith(color: EvabobColors.ink),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    facts,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.label.copyWith(color: EvabobColors.inkMuted),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    state,
                    style: Type.label.copyWith(
                      color: state == 'Live'
                          ? EvabobColors.emeraldDeep
                          : EvabobColors.inkMuted,
                    ),
                  ),
                ],
              ),
            ),
            if (busy)
              const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              Semantics(
                label: post.active ? 'Take off the market' : 'Make it live',
                child: Switch(value: post.active, onChanged: onLive),
              ),
          ],
        ),
      ),
    );
  }
}

/// Something the person paid for.
class _BoughtTile extends StatelessWidget {
  const _BoughtTile({
    required this.deal,
    required this.post,
    required this.onTap,
    this.onRate,
  });

  final MarketDeal deal;
  final MarketPost? post;
  final VoidCallback onTap;
  final VoidCallback? onRate;

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    return PressScale(
      onTap: onTap,
      scale: 0.98,
      child: Glass(
        child: Row(
          children: [
            if (post != null) ...[
              MarketThumb(post: post!, size: 52),
              const SizedBox(width: Space.md),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    deal.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.body.copyWith(color: EvabobColors.ink),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${fx.primary(deal.priceUsd)} · from ${deal.withWhom}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.label.copyWith(color: EvabobColors.inkMuted),
                  ),
                  const SizedBox(height: 2),
                  if (deal.reviewStars != null)
                    StarRow(stars: deal.reviewStars!, size: 14)
                  else
                    Text(
                      deal.statusLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Type.label.copyWith(color: EvabobColors.inkMuted),
                    ),
                ],
              ),
            ),
            if (onRate != null)
              FilledButton(onPressed: onRate, child: const Text('Rate')),
          ],
        ),
      ),
    );
  }
}
