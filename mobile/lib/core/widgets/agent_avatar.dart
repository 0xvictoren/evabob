import 'package:flutter/material.dart';

import '../theme/evabob_colors.dart';

/// The Evabob assistant's profile picture. It intentionally uses the same
/// bundled logo as the launcher icon so the official agent cannot be confused
/// with a user-created bot or contact.
class EvabobAgentAvatar extends StatelessWidget {
  const EvabobAgentAvatar({super.key, this.size = 40});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      image: true,
      label: 'Evabob Agent',
      child: Container(
        width: size,
        height: size,
        padding: EdgeInsets.all(size * .08),
        decoration: BoxDecoration(
          color: EvabobColors.white,
          shape: BoxShape.circle,
          border: Border.all(color: EvabobColors.hairline),
        ),
        child: ClipOval(
          child: Image.asset('assets/logo.png', fit: BoxFit.cover),
        ),
      ),
    );
  }
}
