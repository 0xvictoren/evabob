import 'package:flutter/material.dart';

import '../../core/activity/activity_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/widgets/asset_thumbnail.dart';
import '../../core/widgets/bundle_avatar.dart';

/// The picture at the start of an activity row: the person's face for a
/// payment with someone, the token for everything else — conversions, moves
/// between networks, top-ups. A small dot marks a payment still on hold.
class ActivityThumb extends StatelessWidget {
  const ActivityThumb({super.key, required this.entry, this.size = 40});

  final ActivityEntry entry;
  final double size;

  static const _tokenKinds = {'exchange', 'bridge', 'fund', 'withdraw', 'agent', 'system'};

  static bool _looksLikeAddress(String v) => v.startsWith('0x') && v.length >= 20;

  @override
  Widget build(BuildContext context) {
    final Widget face;
    final who = entry.personName ??
        ((entry.counterparty ?? '').trim().isNotEmpty &&
                !_looksLikeAddress(entry.counterparty!.trim()) &&
                !_tokenKinds.contains(entry.kind)
            ? entry.counterparty!.trim()
            : null);
    if (who != null) {
      face = PeerAvatar(
        name: who,
        avatarUrl: entry.personAvatarUrl,
        bundleIndex: entry.personAvatarBundle,
        size: size,
      );
    } else {
      face = AssetThumbnail(asset: entry.displayToken, size: size);
    }
    if (!entry.isPending) return face;
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          face,
          Positioned(
            right: -1,
            bottom: -1,
            child: Container(
              width: size * 0.34,
              height: size * 0.34,
              decoration: BoxDecoration(
                color: EvabobColors.danger,
                shape: BoxShape.circle,
                border: Border.all(color: EvabobColors.white, width: 2),
              ),
              child: Icon(Icons.schedule_rounded, size: size * 0.2, color: EvabobColors.white),
            ),
          ),
        ],
      ),
    );
  }
}
