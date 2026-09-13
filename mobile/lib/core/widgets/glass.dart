import 'package:flutter/material.dart';
import '../theme/evabob_colors.dart';
import '../theme/evabob_tokens.dart';

/// The white raised surface used throughout the Figma system.
class Glass extends StatelessWidget {
  const Glass({
    super.key,
    required this.child,
    this.padding,
    this.borderRadius = 12,
    this.heavy = false,
    this.color,
  });

  final Widget child;
  final EdgeInsetsGeometry? padding;
  final double borderRadius;
  final bool heavy;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final r = BorderRadius.circular(borderRadius > 16 ? 16 : borderRadius);
    return Container(
      padding: padding ?? const EdgeInsets.all(20),
      decoration: BoxDecoration(
        borderRadius: r,
        color: color ?? EvabobColors.sheet,
        boxShadow: Shadows.card,
      ),
      child: child,
    );
  }
}

class FlatSurfaceCard extends StatelessWidget {
  const FlatSurfaceCard({
    super.key,
    required this.child,
    this.padding,
  });

  final Widget child;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: EvabobColors.sheet,
        borderRadius: BorderRadius.circular(12),
        boxShadow: Shadows.card,
      ),
      child: child,
    );
  }
}

class PressScale extends StatefulWidget {
  const PressScale({
    super.key,
    required this.child,
    this.onTap,
    this.scale = 0.97,
  });

  final Widget child;
  final VoidCallback? onTap;
  final double scale;

  @override
  State<PressScale> createState() => _PressScaleState();
}

class _PressScaleState extends State<PressScale> {
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    // Everything else in the app that moves checks this; press feedback did
    // not, so it kept springing for someone who had asked the OS for no
    // animation.
    final reduced = Motion.reduced(context);
    return GestureDetector(
      onTapDown: reduced ? null : (_) => setState(() => _down = true),
      onTapUp: reduced ? null : (_) => setState(() => _down = false),
      onTapCancel: reduced ? null : () => setState(() => _down = false),
      onTap: widget.onTap,
      child: reduced
          ? widget.child
          : AnimatedScale(
              scale: _down ? widget.scale : 1,
              duration: const Duration(milliseconds: 220),
              curve: const Cubic(0.32, 0.72, 0, 1),
              child: widget.child,
            ),
    );
  }
}
