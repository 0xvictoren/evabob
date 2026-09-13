import 'package:flutter/material.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/glass.dart';

/// Number + operator pad. Calculation updates live (no `=` / `C`).
/// Full-width [sendLabel] action occupies the former `=` / `C` row.
class AmountKeypad extends StatelessWidget {
  const AmountKeypad({
    super.key,
    required this.onKey,
    required this.onSend,
    required this.sendLabel,
    this.canSend = false,
  });

  final ValueChanged<String> onKey;
  final VoidCallback? onSend;
  final String sendLabel;
  final bool canSend;

  static const _keys = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['.', '0', '⌫'],
  ];

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
          r'$0.10 fee · usually a few seconds',
          style: TextStyle(
            color: EvabobColors.inkTertiary,
            fontSize: 10,
            height: 1.4,
            letterSpacing: .2,
          ),
        ),
        const SizedBox(height: 14),
        Container(
          height: 218,
          padding: const EdgeInsets.all(Space.xs),
          decoration: const BoxDecoration(
            color: EvabobColors.white,
            borderRadius: BorderRadius.all(Radius.circular(14)),
          ),
          child: Column(
            children: [
              for (final row in _keys)
                Expanded(
                  child: Row(
                    children: [
                      for (final k in row)
                        Expanded(
                          child: PressScale(
                            scale: Motion.pressScale,
                            onTap: () => onKey(k),
                            child: Center(
                              child: k == '⌫'
                                  ? const Icon(
                                      Icons.backspace_outlined,
                                      size: 20,
                                      color: EvabobColors.inkMuted,
                                    )
                                  : Text(
                                      k,
                                      style: const TextStyle(
                                        fontSize: 22,
                                        fontWeight: FontWeight.w400,
                                        fontFeatures: [
                                          FontFeature.tabularFigures(),
                                        ],
                                        color: EvabobColors.nearBlack,
                                      ),
                                    ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}
