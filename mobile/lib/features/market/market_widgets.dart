import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/config/env.dart';
import '../../core/fx/fx_service.dart';
import '../../core/market/market_api.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/bundle_avatar.dart';
import '../../core/widgets/glass.dart';

/// A full address for a photo the server stores (`/uploads/…`).
String marketPhotoUrl(String path) {
  if (path.startsWith('http')) return path;
  final base = Env.resolveApiBaseUrl().replaceAll(RegExp(r'/$'), '');
  return '$base$path';
}

IconData marketCategoryIcon(String id) => switch (id) {
      'home' => Icons.cleaning_services_rounded,
      'food' => Icons.restaurant_rounded,
      'repairs' => Icons.handyman_rounded,
      'fashion' => Icons.checkroom_rounded,
      'beauty' => Icons.content_cut_rounded,
      'phones' => Icons.phone_iphone_rounded,
      'design' => Icons.palette_rounded,
      'tech' => Icons.code_rounded,
      'lessons' => Icons.school_rounded,
      'events' => Icons.celebration_rounded,
      'delivery' => Icons.local_shipping_rounded,
      'farm' => Icons.agriculture_rounded,
      'rentals' => Icons.key_rounded,
      _ => Icons.category_rounded,
    };

/// How good a seller's record is, as one small pill: the tier, and the
/// rating once buyers who paid have left one.
class ReputationPill extends StatelessWidget {
  const ReputationPill({super.key, required this.seller, this.dense = false});

  final MarketSeller seller;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final strong = seller.tier == 'top' || seller.tier == 'trusted';
    final fg = strong ? EvabobColors.onPrimary : EvabobColors.navyMuted;
    final rating = seller.rating;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 8 : 10, vertical: 4),
      decoration: BoxDecoration(
        color: strong ? EvabobColors.primary : EvabobColors.pageBg,
        borderRadius: Radii.all(Radii.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            seller.tier == 'top'
                ? Icons.workspace_premium_rounded
                : seller.tier == 'trusted'
                    ? Icons.verified_rounded
                    : Icons.shield_outlined,
            size: 14,
            color: fg,
          ),
          const SizedBox(width: 4),
          Text(
            rating != null
                ? '${rating.toStringAsFixed(1)} · ${seller.tierLabel}'
                : seller.tierLabel,
            style: Type.label.copyWith(color: fg),
          ),
        ],
      ),
    );
  }
}

/// A post in a list: photo or category picture, what it is, the price, who
/// and how near.
class MarketPostTile extends StatelessWidget {
  const MarketPostTile({super.key, required this.post, required this.onTap});

  final MarketPost post;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final fx = context.watch<FxService>();
    return PressScale(
      onTap: onTap,
      scale: 0.98,
      child: Glass(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MarketThumb(post: post, size: 84),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    post.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Type.body.copyWith(color: EvabobColors.ink),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    post.isWant
                        ? 'Pays up to ${fx.primary(post.priceUsd)}'
                        : fx.primary(post.priceUsd),
                    style: Type.amount.copyWith(
                      color: EvabobColors.emeraldDeep,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Icon(
                        post.remote && (post.near ?? '').startsWith('Works')
                            ? Icons.public_rounded
                            : Icons.place_outlined,
                        size: 14,
                        color: EvabobColors.inkMuted,
                      ),
                      const SizedBox(width: 3),
                      Expanded(
                        child: Text(
                          post.near ?? post.placeLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Type.label
                              .copyWith(color: EvabobColors.inkMuted),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          post.seller.shownName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style:
                              Type.label.copyWith(color: EvabobColors.ink),
                        ),
                      ),
                      const SizedBox(width: 8),
                      ReputationPill(seller: post.seller, dense: true),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The first photo of a post, or its category's picture when it has none.
class MarketThumb extends StatelessWidget {
  const MarketThumb({super.key, required this.post, this.size = 84});

  final MarketPost post;
  final double size;

  @override
  Widget build(BuildContext context) {
    final fallback = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: EvabobColors.pageBg,
        borderRadius: Radii.all(Radii.sm),
      ),
      child: Icon(
        marketCategoryIcon(post.category),
        size: size * 0.4,
        color: EvabobColors.primary,
      ),
    );
    if (post.photos.isEmpty) return fallback;
    return ClipRRect(
      borderRadius: Radii.all(Radii.sm),
      child: Image.network(
        marketPhotoUrl(post.photos.first),
        width: size,
        height: size,
        fit: BoxFit.cover,
        // Decoded at the size shown, not the size uploaded.
        cacheWidth: (size * 2).round(),
        errorBuilder: (_, __, ___) => fallback,
        loadingBuilder: (_, child, progress) =>
            progress == null ? child : fallback,
      ),
    );
  }
}

/// Who is behind a post, with the facts their score is made of.
class SellerCard extends StatelessWidget {
  const SellerCard({super.key, required this.person, this.onCopySocial});

  /// The server's "person card" (services/market.ts personCard).
  final Map<String, dynamic> person;
  final void Function(String url)? onCopySocial;

  @override
  Widget build(BuildContext context) {
    final rep = person['reputation'] is Map
        ? Map<String, dynamic>.from(person['reputation'] as Map)
        : const <String, dynamic>{};
    final seller = MarketSeller.fromJson({
      'id': person['id'],
      'name': person['name'],
      'handle': person['handle'],
      'avatarUrl': person['avatarUrl'],
      'avatarBundleIndex': person['avatarBundleIndex'],
      'score': rep['score'],
      'tier': rep['tier'],
      'tierLabel': rep['tierLabel'],
      'rating': rep['rating'],
      'reviews': rep['reviews'],
      'delivered': (rep['record'] as Map?)?['delivered'],
      'verifiedSocials': rep['verifiedSocials'],
    });
    final reasons = ((rep['reasons'] as List?) ?? const [])
        .map((e) => e.toString())
        .toList();
    final socials = ((person['socials'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final reviews = ((person['reviews'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    final bio = person['bio']?.toString() ?? '';
    final near = person['near']?.toString();
    return Glass(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              PeerAvatar(
                name: seller.name,
                avatarUrl: seller.avatarUrl,
                bundleIndex: seller.avatarBundleIndex,
                size: 48,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      seller.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Type.body.copyWith(color: EvabobColors.ink),
                    ),
                    if (seller.handle != null)
                      Text(
                        seller.handle!,
                        style:
                            Type.label.copyWith(color: EvabobColors.inkMuted),
                      ),
                  ],
                ),
              ),
              ReputationPill(seller: seller),
            ],
          ),
          if (bio.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(bio, style: Type.label.copyWith(color: EvabobColors.ink)),
          ],
          const SizedBox(height: 12),
          // The score, and the plain facts it is made of.
          Row(
            children: [
              Expanded(
                child: ClipRRect(
                  borderRadius: Radii.all(Radii.pill),
                  child: LinearProgressIndicator(
                    value: (seller.score / 100).clamp(0.0, 1.0),
                    minHeight: 6,
                    backgroundColor: EvabobColors.pageBg,
                    color: EvabobColors.primary,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                '${seller.score}/100',
                style: Type.amountSmall.copyWith(color: EvabobColors.ink),
              ),
            ],
          ),
          const SizedBox(height: 8),
          for (final r in reasons)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.only(top: 2, right: 6),
                    child: Icon(Icons.check_circle_outline_rounded,
                        size: 14, color: EvabobColors.inkMuted),
                  ),
                  Expanded(
                    child: Text(r,
                        style:
                            Type.label.copyWith(color: EvabobColors.inkMuted)),
                  ),
                ],
              ),
            ),
          if (near != null && near.isNotEmpty) ...[
            const SizedBox(height: 2),
            Row(
              children: [
                const Padding(
                  padding: EdgeInsets.only(right: 6),
                  child: Icon(Icons.place_outlined,
                      size: 14, color: EvabobColors.inkMuted),
                ),
                Expanded(
                  child: Text(near,
                      style:
                          Type.label.copyWith(color: EvabobColors.inkMuted)),
                ),
              ],
            ),
          ],
          if (socials.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final s in socials)
                  ActionChip(
                    avatar: Icon(
                      s['verified'] == true
                          ? Icons.verified_rounded
                          : Icons.link_rounded,
                      size: 16,
                      color: s['verified'] == true
                          ? EvabobColors.primary
                          : EvabobColors.inkMuted,
                    ),
                    label: Text(
                      '${s['name']}${s['verified'] == true ? ' · checked' : ' · not checked'}',
                      style: const TextStyle(fontSize: 12),
                    ),
                    backgroundColor: EvabobColors.pageBg,
                    side: BorderSide.none,
                    onPressed: () =>
                        onCopySocial?.call(s['url']?.toString() ?? ''),
                  ),
              ],
            ),
          ],
          if (reviews.isNotEmpty) ...[
            const SizedBox(height: 14),
            const Divider(),
            const SizedBox(height: 10),
            Text('What buyers said',
                style: Type.label.copyWith(color: EvabobColors.inkMuted)),
            for (final r in reviews.take(3))
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        StarRow(stars: (r['stars'] as num?)?.toInt() ?? 0),
                        const SizedBox(width: 8),
                        Text(r['by']?.toString() ?? '',
                            style: Type.label
                                .copyWith(color: EvabobColors.inkMuted)),
                      ],
                    ),
                    if ((r['text']?.toString() ?? '').isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(r['text'].toString(),
                            style:
                                Type.label.copyWith(color: EvabobColors.ink)),
                      ),
                  ],
                ),
              ),
          ],
        ],
      ),
    );
  }
}

class StarRow extends StatelessWidget {
  const StarRow({super.key, required this.stars, this.size = 16, this.onPick});

  final int stars;
  final double size;
  final ValueChanged<int>? onPick;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 1; i <= 5; i++)
          GestureDetector(
            onTap: onPick == null ? null : () => onPick!(i),
            child: Padding(
              padding: EdgeInsets.all(onPick == null ? 0 : 4),
              child: Icon(
                i <= stars ? Icons.star_rounded : Icons.star_outline_rounded,
                size: size,
                color: i <= stars
                    ? EvabobColors.primary
                    : EvabobColors.inkTertiary,
              ),
            ),
          ),
      ],
    );
  }
}

/// A line that says how payment works, wherever a price is about to be paid.
class HowPaymentWorks extends StatelessWidget {
  const HowPaymentWorks({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.lock_outline_rounded,
            size: 16, color: EvabobColors.emeraldDeep),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            'You choose how to pay: set it all aside until it is delivered, '
            'pay half now and hold half, or pay it all if you know them.',
            style: Type.label.copyWith(color: EvabobColors.inkMuted),
          ),
        ),
      ],
    );
  }
}

/// State and area fields, shared by the post form and the profile.
class PlaceFields extends StatelessWidget {
  const PlaceFields({
    super.key,
    required this.state,
    required this.area,
    required this.onState,
  });

  final String? state;
  final TextEditingController area;
  final ValueChanged<String?> onState;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DropdownButtonFormField<String>(
          // ignore: deprecated_member_use
          value: marketStates.contains(state) ? state : null,
          isExpanded: true,
          decoration: const InputDecoration(hintText: 'State'),
          items: [
            for (final s in marketStates)
              DropdownMenuItem(value: s, child: Text(s)),
          ],
          onChanged: onState,
        ),
        const SizedBox(height: 8),
        TextField(
          controller: area,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(
            hintText: 'Area or town, e.g. Lekki, Wuse 2, Bodija',
          ),
        ),
      ],
    );
  }
}
