import 'package:flutter/material.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/glass.dart';

/// The full-width Send button under the amount. The amount itself is typed
/// with the phone's own number keyboard.
class SendActionButton extends StatelessWidget {
  const SendActionButton({
    super.key,
    required this.onSend,
    required this.sendLabel,
    this.canSend = false,
  });

  final VoidCallback? onSend;
  final String sendLabel;
  final bool canSend;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: PressScale(
            scale: Motion.pressScale,
            onTap: canSend ? onSend : null,
            child: AnimatedOpacity(
              opacity: canSend ? 1 : 0.4,
              duration: Motion.fast,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 18),
                decoration: BoxDecoration(
                  color: canSend ? EvabobColors.blue : EvabobColors.lightDark,
                  borderRadius: BorderRadius.circular(999),
                  boxShadow: canSend ? Shadows.button : const [],
                ),
                alignment: Alignment.center,
                child: Text(
                  sendLabel,
                  style: TextStyle(
                    color: canSend
                        ? EvabobColors.onPrimary
                        : EvabobColors.navyMuted,
                    fontSize: 14,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ),
            ),
          ),
        ),
        const Text(
          'Usually arrives in a few seconds',
          style: TextStyle(
            color: EvabobColors.inkTertiary,
            fontSize: 10,
            height: 1.4,
            letterSpacing: .2,
          ),
        ),
      ],
    );
  }
}
