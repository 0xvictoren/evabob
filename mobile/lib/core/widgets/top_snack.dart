import 'dart:async';

import 'package:flutter/material.dart';

/// Shows a short message sliding down from the top of the screen.
///
/// Takes the same [SnackBar] the app already builds — its content, action and
/// duration — so every "Link copied" or "Paid" appears at the top, where the
/// person is looking, instead of at the bottom behind their thumb.
void showTopSnack(BuildContext context, SnackBar bar) {
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(bar);
    return;
  }
  _TopSnackHost.show(overlay, bar, Theme.of(context));
}

/// The same message, for callers with no context under the overlay — the
/// web-app's alert banners, raised from outside any screen.
void showTopSnackOn(OverlayState overlay, SnackBar bar, ThemeData theme) =>
    _TopSnackHost.show(overlay, bar, theme);

class _TopSnackHost {
  static OverlayEntry? _entry;

  static void show(OverlayState overlay, SnackBar bar, ThemeData theme) {
    // One message at a time: a new one replaces the one showing.
    if (_entry?.mounted ?? false) _entry!.remove();
    late OverlayEntry entry;
    entry = OverlayEntry(
      builder: (_) => Theme(
        data: theme,
        child: _TopSnack(
          bar: bar,
          onGone: () {
            if (_entry == entry) _entry = null;
            if (entry.mounted) entry.remove();
          },
        ),
      ),
    );
    _entry = entry;
    overlay.insert(entry);
  }
}

class _TopSnack extends StatefulWidget {
  const _TopSnack({required this.bar, required this.onGone});

  final SnackBar bar;
  final VoidCallback onGone;

  @override
  State<_TopSnack> createState() => _TopSnackState();
}

class _TopSnackState extends State<_TopSnack>
    with SingleTickerProviderStateMixin {
  late final AnimationController _anim = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 220),
  );
  Timer? _timer;
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    _anim.forward();
    _timer = Timer(widget.bar.duration, _leave);
  }

  Future<void> _leave() async {
    if (_leaving || !mounted) return;
    _leaving = true;
    _timer?.cancel();
    await _anim.reverse();
    widget.onGone();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _anim.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).snackBarTheme;
    final action = widget.bar.action;
    return Positioned(
      left: 0,
      right: 0,
      top: 0,
      child: SafeArea(
        bottom: false,
        child: SlideTransition(
          position: Tween(begin: const Offset(0, -1.2), end: Offset.zero)
              .animate(
                  CurvedAnimation(parent: _anim, curve: Curves.easeOutCubic)),
          child: Dismissible(
            key: const ValueKey('top-snack'),
            direction: DismissDirection.up,
            onDismissed: (_) {
              _leaving = true;
              _timer?.cancel();
              widget.onGone();
            },
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: Material(
                color: widget.bar.backgroundColor ?? theme.backgroundColor,
                elevation: 6,
                borderRadius: BorderRadius.circular(14),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: DefaultTextStyle.merge(
                          style: theme.contentTextStyle,
                          child: widget.bar.content,
                        ),
                      ),
                      if (action != null)
                        TextButton(
                          onPressed: () {
                            action.onPressed();
                            _leave();
                          },
                          child: Text(action.label),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
