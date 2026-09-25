import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/glass.dart';

class HomeActionRow extends StatelessWidget {
  const HomeActionRow({
    super.key,
    required this.onSend,
    required this.onScan,
    required this.onRequest,
    this.showSend = true,
    this.showRequest = true,
  });

  final VoidCallback onSend;
  final VoidCallback onScan;
  final VoidCallback onRequest;
  final bool showSend;
  final bool showRequest;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        // Request on the left, Send on the right: the thumb that pays sits
        // on the side most people reach first.
        if (showRequest) ...[
          Expanded(
            child: _ActionPill(
              label: '↙  Request',
              foreground: EvabobColors.white,
              background: EvabobColors.white.withValues(alpha: .18),
              onTap: onRequest,
            ),
          ),
          const SizedBox(width: 13),
        ],
        Semantics(
          button: true,
          label: 'Scan a code',
          child: PressScale(
            onTap: onScan,
            scale: Motion.pressScale,
            child: Container(
              width: 56,
              height: 56,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: EvabobColors.blue,
                shape: BoxShape.circle,
              ),
              child: SvgPicture.asset(
                'assets/icons/qr.svg',
                width: 24,
                height: 24,
                colorFilter: const ColorFilter.mode(
                  EvabobColors.white,
                  BlendMode.srcIn,
                ),
              ),
            ),
          ),
        ),
        if (showSend) ...[
          const SizedBox(width: 13),
          Expanded(
            child: _ActionPill(
              label: '↗  Send',
              foreground: EvabobColors.ink,
              background: EvabobColors.white,
              shadow: Shadows.card,
              onTap: onSend,
            ),
          ),
        ],
      ],
    );
  }
}

class _ActionPill extends StatelessWidget {
  const _ActionPill({
    required this.label,
    required this.foreground,
    required this.background,
    required this.onTap,
    this.shadow = const [],
  });

  final String label;
  final Color foreground;
  final Color background;
  final VoidCallback onTap;
  final List<BoxShadow> shadow;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label.replaceAll(RegExp(r'[^A-Za-z ]'), '').trim(),
      child: PressScale(
        onTap: onTap,
        scale: Motion.pressScale,
        child: Container(
          height: 56,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(999),
            boxShadow: shadow,
          ),
          child: Text(label, style: Type.body.copyWith(color: foreground)),
        ),
      ),
    );
  }
}
