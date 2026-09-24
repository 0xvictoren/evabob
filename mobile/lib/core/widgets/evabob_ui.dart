import 'package:flutter/material.dart';

import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';
import 'glass.dart';

class EvabobPageHeader extends StatelessWidget {
  const EvabobPageHeader({
    super.key,
    required this.title,
    this.onBack,
    this.trailing,
    this.root = false,
  });

  final String title;
  final VoidCallback? onBack;
  final Widget? trailing;
  final bool root;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: root ? 52 : 64,
      child: Row(
        children: [
          if (onBack != null) ...[
            PressScale(
              onTap: onBack,
              scale: Motion.pressScale,
              child: Semantics(
                button: true,
                label: 'Back',
                child: const SizedBox.square(
                  dimension: 44,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: EvabobColors.white,
                      shape: BoxShape.circle,
                      boxShadow: Shadows.card,
                    ),
                    child: Icon(Icons.chevron_left_rounded, size: 24),
                  ),
                ),
              ),
            ),
            const SizedBox(width: 6),
          ],
          Expanded(
            child: Semantics(
              header: true,
              child: Text(
                title,
                textAlign: onBack == null ? TextAlign.left : TextAlign.center,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: (root ? Type.title : Type.body).copyWith(
                  color: EvabobColors.ink,
                  letterSpacing: root ? -0.2 : 0,
                ),
              ),
            ),
          ),
          if (trailing != null)
            SizedBox(width: 44, height: 44, child: Center(child: trailing))
          else if (onBack != null)
            const SizedBox(width: 50),
        ],
      ),
    );
  }
}

class EvabobSectionLabel extends StatelessWidget {
  const EvabobSectionLabel(this.label, {super.key, this.trailing});

  final String label;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      header: true,
      child: Row(
        children: [
          Expanded(
            child: Text(
              label.toUpperCase(),
              style: Type.section.copyWith(color: EvabobColors.inkTertiary),
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

class EvabobPrimaryButton extends StatelessWidget {
  const EvabobPrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.busy = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null && !busy;
    return Semantics(
      button: true,
      enabled: enabled,
      label: label,
      child: PressScale(
        onTap: enabled ? onPressed : null,
        scale: Motion.pressScale,
        child: AnimatedOpacity(
          opacity: enabled ? 1 : .4,
          duration: Motion.fast,
          child: Container(
            width: double.infinity,
            constraints: const BoxConstraints(minHeight: 56),
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            decoration: BoxDecoration(
              color: EvabobColors.blue,
              borderRadius: BorderRadius.all(Radius.circular(999)),
              boxShadow: Shadows.button,
            ),
            alignment: Alignment.center,
            child: busy
                ? const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: EvabobColors.white,
                    ),
                  )
                : Text(
                    label,
                    textAlign: TextAlign.center,
                    style: Type.body.copyWith(color: EvabobColors.white),
                  ),
          ),
        ),
      ),
    );
  }
}

class TestnetBadge extends StatelessWidget {
  const TestnetBadge({super.key});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Testnet environment',
      child: Container(
        height: 28,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: EvabobColors.pageBg,
          borderRadius: BorderRadius.all(Radius.circular(999)),
        ),
        child: Text(
          'TESTNET',
          style: Type.label.copyWith(color: EvabobColors.blue),
        ),
      ),
    );
  }
}
