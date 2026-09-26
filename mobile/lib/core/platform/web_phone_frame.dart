import 'package:flutter/material.dart';

import '../theme/evabob_colors.dart';

/// Web-app on a wide screen: shows the app at phone width, centred, instead
/// of stretching a phone layout across a laptop. Narrow windows (phones,
/// small tabs) get the app edge to edge, exactly as on the phones.
///
/// Screens size themselves from [MediaQuery], so the frame reports its own
/// width to everything inside it — dialogs and sheets open inside it too.
class WebPhoneFrame extends StatelessWidget {
  const WebPhoneFrame({super.key, required this.child});

  final Widget child;

  static const _maxWidth = 430.0;
  static const _frameFrom = 560.0;

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context);
    if (media.size.width < _frameFrom) return child;
    final height = media.size.height;
    return ColoredBox(
      color: EvabobColors.black,
      child: Center(
        child: SizedBox(
          width: _maxWidth,
          height: height,
          child: MediaQuery(
            data: media.copyWith(size: Size(_maxWidth, height)),
            child: ClipRect(child: child),
          ),
        ),
      ),
    );
  }
}
