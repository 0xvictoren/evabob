import 'package:flutter/material.dart';

import '../../core/chat/chat_models.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';

/// Four tiles: the assistant, two people, and a way through to the rest.
///
/// This was "Send Again", a grid of faces whose fourth tile added a contact.
/// The brief turns it into Chat, because that is what tapping a face actually
/// does — it opens a conversation, and money happens inside it.
///
/// The fourth tile now opens the full chat list rather than adding a contact.
/// Adding someone from a screen showing your recent conversations was always
/// the odd one out.
class HomeChatGrid extends StatelessWidget {
  const HomeChatGrid({
    super.key,
    required this.agent,
    required this.recent,
    required this.onOpenThread,
    required this.onSeeAll,
  });

  /// The assistant, pinned first. Null before threads have loaded.
  final ChatThread? agent;

  /// The people talked to most, minus the assistant.
  final List<ChatThread> recent;

  final void Function(ChatThread thread) onOpenThread;
  final VoidCallback onSeeAll;

  @override
  Widget build(BuildContext context) {
    final tiles = <Widget>[];

    if (agent != null) {
      tiles.add(_Tile(
        key: const ValueKey('agent'),
        label: 'Evabob',
        icon: Icons.auto_awesome_rounded,
        highlight: true,
        onTap: () => onOpenThread(agent!),
      ));
    }
    for (final t in recent.take(agent == null ? 3 : 2)) {
      tiles.add(_Tile(
        key: ValueKey(t.id),
        label: t.title,
        initials: _initials(t.title),
        onTap: () => onOpenThread(t),
      ));
    }
    while (tiles.length < 3) {
      tiles.add(const _EmptyTile());
    }
    tiles.add(_Tile(
      key: const ValueKey('all'),
      label: 'All chats',
      icon: Icons.more_horiz_rounded,
      onTap: onSeeAll,
    ));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Chat',
            style: Type.section.copyWith(color: EvabobColors.nearBlack)),
        const SizedBox(height: Space.md),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: Space.sm,
          crossAxisSpacing: Space.sm,
          children: [
            for (var i = 0; i < tiles.length; i++)
              RiseIn(index: i, child: tiles[i]),
          ],
        ),
      ],
    );
  }

  static String _initials(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty);
    if (parts.isEmpty) return '?';
    return parts.take(2).map((p) => p[0].toUpperCase()).join();
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    super.key,
    required this.label,
    required this.onTap,
    this.icon,
    this.initials,
    this.highlight = false,
  });

  final String label;
  final VoidCallback onTap;
  final IconData? icon;
  final String? initials;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    return PressScale(
      scale: Motion.pressScale,
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: highlight ? EvabobColors.creamDeep : EvabobColors.sheet,
          borderRadius: Radii.all(Radii.md),
          border: Border.all(
            color: highlight
                ? EvabobColors.emerald.withValues(alpha: 0.35)
                : EvabobColors.hairline,
          ),
          boxShadow: Shadows.subtle,
        ),
        padding: const EdgeInsets.all(Space.md),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: highlight
                    ? EvabobColors.emerald.withValues(alpha: 0.18)
                    : EvabobColors.sand,
                shape: BoxShape.circle,
              ),
              alignment: Alignment.center,
              child: icon != null
                  ? Icon(
                      icon,
                      size: 19,
                      color: highlight
                          ? EvabobColors.emerald
                          : EvabobColors.nearBlack,
                    )
                  : Text(
                      initials ?? '?',
                      style: Type.label.copyWith(color: EvabobColors.nearBlack),
                    ),
            ),
            const SizedBox(height: Space.sm),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Type.caption.copyWith(
                color: EvabobColors.nearBlack,
                fontWeight: FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Holds the grid's shape before there is anyone to show, so the layout does
/// not jump as threads load in.
class _EmptyTile extends StatelessWidget {
  const _EmptyTile();

  @override
  Widget build(BuildContext context) {
    // It held the shape and said nothing, so a new user met two blank grey
    // rectangles where their people will be.
    return Container(
      decoration: BoxDecoration(
        color: EvabobColors.sheet.withValues(alpha: 0.5),
        borderRadius: Radii.all(Radii.md),
        border: Border.all(color: EvabobColors.hairline),
      ),
      alignment: Alignment.center,
      padding: const EdgeInsets.all(Space.sm),
      child: Text(
        'People you pay\nshow up here',
        textAlign: TextAlign.center,
        style: Type.micro.copyWith(color: EvabobColors.navyMuted),
      ),
    );
  }
}
