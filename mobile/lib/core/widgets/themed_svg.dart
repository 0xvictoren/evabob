import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../theme/evabob_colors.dart';

/// A Figma SVG drawn in the chosen colour theme: the blue design's three
/// tones (base, light, light-dark) are swapped for the current theme's.
class ThemedSvg extends StatelessWidget {
  const ThemedSvg(
    this.asset, {
    super.key,
    this.width,
    this.height,
    this.fit = BoxFit.contain,
  });

  final String asset;
  final double? width;
  final double? height;
  final BoxFit fit;

  static final Map<String, Future<String>> _raw = {};

  static String _hex(Color c) =>
      '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

  static String recolor(String svg, EvabobPalette palette) => svg
      .replaceAll(RegExp('#00B5FF', caseSensitive: false), _hex(palette.base))
      .replaceAll(RegExp('#F0FAFF', caseSensitive: false), _hex(palette.light))
      .replaceAll(
          RegExp('#ACE3FF', caseSensitive: false), _hex(palette.lightDark));

  @override
  Widget build(BuildContext context) {
    final palette = EvabobColors.palette;
    return FutureBuilder<String>(
      future: _raw.putIfAbsent(asset, () => rootBundle.loadString(asset)),
      builder: (context, snap) {
        final svg = snap.data;
        if (svg == null) return SizedBox(width: width, height: height);
        return SvgPicture.string(
          recolor(svg, palette),
          width: width,
          height: height,
          fit: fit,
        );
      },
    );
  }
}
