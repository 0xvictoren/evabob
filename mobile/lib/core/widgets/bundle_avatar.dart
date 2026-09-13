import 'dart:io';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../auth/evabob_auth.dart';
import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';

/// The 22 bundled profile illustrations live at `assets/dp-pic-asset/N.webp`
/// (1-indexed on disk, 0-indexed everywhere in code).
const int kBundleAvatarCount = 22;

String bundleAvatarAsset(int index) =>
    'assets/dp-pic-asset/${(index % kBundleAvatarCount) + 1}.webp';

/// A stable picture for someone who has not chosen one — same seed, same
/// picture, across sessions and devices. Used for the account holder before
/// they pick, never for contacts (initials disambiguate those; 22 pictures
/// cannot).
int deterministicAvatarIndex(String seed) {
  if (seed.isEmpty) return 0;
  return seed.hashCode.abs() % kBundleAvatarCount;
}

/// The account holder's picture, resolved in order:
/// custom upload file → custom upload URL → chosen bundle illustration →
/// a deterministic bundle illustration from the user id.
///
/// Initials are never a fallback here — that was the app's most obvious
/// "unfinished" tell.
class UserAvatar extends StatelessWidget {
  const UserAvatar({super.key, this.size = 40, this.onTap});

  final double size;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<EvabobAuth>();

    ImageProvider provider;
    final path = auth.avatarPath;
    final url = auth.resolvedAvatarUrl;
    if (path != null && path.isNotEmpty && File(path).existsSync()) {
      provider = FileImage(File(path));
    } else if (url != null && url.isNotEmpty) {
      provider = NetworkImage(url);
    } else {
      final idx = auth.avatarBundleIndex ??
          deterministicAvatarIndex(auth.user?.id ?? auth.circleUserId);
      provider = AssetImage(bundleAvatarAsset(idx));
    }

    final avatar = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: EvabobColors.creamDeep,
        border: Border.all(color: EvabobColors.hairline),
        image: DecorationImage(image: provider, fit: BoxFit.cover),
      ),
    );

    if (onTap == null) return avatar;
    return Semantics(
      button: true,
      label: 'Change your picture',
      child: GestureDetector(onTap: onTap, child: avatar),
    );
  }
}

/// A single bundled illustration, by index — for the picker grid.
class BundleAvatarTile extends StatelessWidget {
  const BundleAvatarTile({
    super.key,
    required this.index,
    required this.selected,
    required this.onTap,
  });

  final int index;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(
            color: selected ? EvabobColors.emerald : EvabobColors.hairline,
            width: selected ? 2.5 : 1,
          ),
          image: DecorationImage(
            image: AssetImage(bundleAvatarAsset(index)),
            fit: BoxFit.cover,
          ),
        ),
      ),
    );
  }
}

/// The picker: a grid of the 22 illustrations plus "Upload a photo".
///
/// [onUpload] is the app's existing image-picker flow. Choosing a bundle
/// illustration is handled here directly via [EvabobAuth.setAvatarBundleIndex].
Future<void> showAvatarPicker(
  BuildContext context, {
  required VoidCallback onUpload,
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (ctx) {
      final auth = ctx.read<EvabobAuth>();
      final current = auth.avatarBundleIndex ??
          ((auth.avatarPath == null && auth.avatarUrl == null)
              ? deterministicAvatarIndex(auth.user?.id ?? auth.circleUserId)
              : null);
      return SafeArea(
        top: false,
        child: Container(
          margin: const EdgeInsets.all(Space.md),
          padding: const EdgeInsets.all(Space.lg),
          decoration: BoxDecoration(
            color: EvabobColors.sheet,
            borderRadius: Radii.all(Radii.lg),
            border: Border.all(color: EvabobColors.hairline),
            boxShadow: Shadows.raised,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Your picture',
                style: Type.section.copyWith(color: EvabobColors.nearBlack),
              ),
              const SizedBox(height: Space.md),
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                itemCount: kBundleAvatarCount,
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 5,
                  mainAxisSpacing: Space.sm,
                  crossAxisSpacing: Space.sm,
                ),
                itemBuilder: (_, i) => BundleAvatarTile(
                  index: i,
                  selected: current == i,
                  onTap: () {
                    auth.setAvatarBundleIndex(i);
                    Navigator.pop(ctx);
                  },
                ),
              ),
              const SizedBox(height: Space.md),
              SizedBox(
                height: 48,
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: EvabobColors.nearBlack,
                    side: const BorderSide(color: EvabobColors.hairline),
                    shape: RoundedRectangleBorder(
                      borderRadius: Radii.all(Radii.pill),
                    ),
                  ),
                  onPressed: () {
                    Navigator.pop(ctx);
                    onUpload();
                  },
                  icon: const Icon(Icons.photo_library_outlined, size: 18),
                  label: const Text('Upload a photo'),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}
