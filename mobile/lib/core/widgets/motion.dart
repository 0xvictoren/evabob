import 'package:flutter/material.dart';

import '../theme/evabob_tokens.dart';

/// A number that counts up to its value instead of snapping in.
///
/// The brief asks for this on the balance figure. It also happens to solve a
/// real problem: balances arrive asynchronously and often land twice — a cached
/// value, then a fresh read — and a figure that snaps twice looks like a
/// glitch, where one that counts reads as loading.
///
/// Animates from whatever was on screen, not from zero, so a refresh that
/// barely changes the number barely moves.
class CountUp extends StatelessWidget {
  const CountUp(
    this.value, {
    super.key,
    required this.builder,
    this.duration = Motion.slow,
  });

  final double value;
  final Duration duration;
  final Widget Function(BuildContext context, double value) builder;

  @override
  Widget build(BuildContext context) {
    if (Motion.reduced(context)) return builder(context, value);
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: value, end: value),
      duration: duration,
      curve: Motion.smooth,
      builder: (context, v, _) => builder(context, v),
    );
  }
}

/// Fades and rises into place, offset by its position in a list.
///
/// The stagger is capped: past about a dozen items the delay stops reading as
/// choreography and starts reading as the list being slow to load.
class RiseIn extends StatelessWidget {
  const RiseIn({
    super.key,
    required this.child,
    this.index = 0,
    this.distance = 12,
  });

  final Widget child;
  final int index;
  final double distance;

  @override
  Widget build(BuildContext context) {
    if (Motion.reduced(context)) return child;
    final delay = Motion.stagger * (index.clamp(0, 12));
    return TweenAnimationBuilder<double>(
      key: ValueKey(index),
      tween: Tween(begin: 0, end: 1),
      duration: Motion.base + delay,
      curve: Interval(
        // The delay is expressed as a slice of a longer curve rather than a
        // real timer, so nothing has to be cancelled when the list rebuilds.
        (delay.inMilliseconds / (Motion.base + delay).inMilliseconds)
            .clamp(0.0, 0.9),
        1,
        curve: Motion.smooth,
      ),
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(
            offset: Offset(0, (1 - t) * distance), child: child),
      ),
      child: child,
    );
  }
}

/// A page route that springs up rather than sliding on rails.
class SpringPageRoute<T> extends PageRouteBuilder<T> {
  SpringPageRoute({required this.page})
      : super(
          transitionDuration: Motion.base,
          reverseTransitionDuration: Motion.fast,
          pageBuilder: (_, __, ___) => page,
          transitionsBuilder: (context, animation, _, child) {
            if (Motion.reduced(context)) {
              return FadeTransition(opacity: animation, child: child);
            }
            final curved = CurvedAnimation(
              parent: animation,
              curve: Motion.spring,
              reverseCurve: Motion.smooth,
            );
            return FadeTransition(
              opacity: animation,
              child: SlideTransition(
                position: Tween(
                  begin: const Offset(0, 0.06),
                  end: Offset.zero,
                ).animate(curved),
                child: child,
              ),
            );
          },
        );

  final Widget page;
}
