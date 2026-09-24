import 'package:flutter/material.dart';

/// Evabob's light-blue design tokens.
///
/// The legacy semantic names are intentionally retained so the visual system
/// can move to the Figma palette without changing feature or payment logic.
/// New code should prefer [primary], [onPrimary], [pageBg], [sheet], [ink],
/// and [inkMuted].
/// The app themes a person can pick in Profile. Each sets the three brand
/// tones; everything else (ink, money, alerts) stays the same.
enum EvabobPalette {
  blue(
    label: 'Blue',
    base: Color(0xFF00B5FF),
    light: Color(0xFFF0FAFF),
    lightDark: Color(0xFFACE3FF),
    deep: Color(0xFF007EA8),
  ),
  pink(
    label: 'Pink',
    base: Color(0xFFFF4FA3),
    light: Color(0xFFFFF3F9),
    lightDark: Color(0xFFFFC6E2),
    deep: Color(0xFFC2186F),
  ),
  grey(
    label: 'Grey',
    base: Color(0xFF667085),
    light: Color(0xFFF8FAFC),
    lightDark: Color(0xFFD0D5DD),
    deep: Color(0xFF475467),
  );

  const EvabobPalette({
    required this.label,
    required this.base,
    required this.light,
    required this.lightDark,
    required this.deep,
  });

  final String label;

  /// Buttons, links, the active tab.
  final Color base;

  /// The page background.
  final Color light;

  /// Soft fills: chips, selected rows, empty states.
  final Color lightDark;

  /// Darker text on light fills.
  final Color deep;

  static EvabobPalette fromName(String? name) => EvabobPalette.values
      .firstWhere((p) => p.name == name, orElse: () => EvabobPalette.blue);
}

class EvabobColors {
  EvabobColors._();

  /// The theme in use. Set by `ThemeService`; the getters below follow it.
  static EvabobPalette palette = EvabobPalette.blue;

  // Primitive colors. [blue] and [blueSoft] keep their names for the existing
  // call sites but follow the chosen theme.
  static Color get blue => palette.base;
  static Color get blueSoft => palette.lightDark;
  static const white = Color(0xFFFFFFFF);
  static const black = Color(0xFF0B1620);
  static const slate = Color(0xFF5A6B78);

  // Semantic colors.
  static Color get primary => blue;
  static const onPrimary = white;
  static Color get pageBg => palette.light;
  static const sheet = white;
  static const ink = black;
  static const inkMuted = slate;
  static const inkTertiary = Color(0xFF64727E);
  static const hairline = Color(0xFFE6EBEF);
  static Color get lightDark => blueSoft;
  static const moneyIn = Color(0xFF01FFA6);

  // Surface aliases used by the existing feature layer.
  static const mint = white;
  static Color get creamDeep => pageBg;
  static const sand = Color(0xFFD8E4EA);
  static const panel = white;
  static Color get cream => pageBg;
  static const glass = Color(0xF2FFFFFF);
  static const glassSoft = Color(0xD9FFFFFF);
  static const glassTint = Color(0xBFFFFFFF);

  // Foreground aliases.
  static const nearBlack = black;
  static const navy = black;
  static const navyMuted = slate;
  static const chalk = inkTertiary;
  static const forest = black;
  static Color get emeraldDeep => palette.deep;

  // Accent aliases. These keep older call sites on the approved blue.
  static Color get lime => primary;
  static Color get emerald => primary;
  static Color get emeraldSoft => blueSoft;
  static Color get emeraldGlow => primary.withAlpha(0x29);

  /// The soft glow under primary buttons.
  static Color get buttonGlow => primary.withAlpha(0x47);
  static const inkElevated = Color(0xFF163849);

  // Semantic money and alert colors.
  static const success = moneyIn;
  static const danger = Color(0xFFD97706);
  static const alert = Color(0xFFCF3345);

  /// Kept as a gradient token for call-site compatibility, but deliberately
  /// resolves to one flat brand color.
  static LinearGradient get gradientEmerald => LinearGradient(
        colors: [primary, primary],
      );

  static LinearGradient get meshWarm =>
      LinearGradient(colors: [pageBg, pageBg]);

  static LinearGradient get meshDark => meshWarm;

  static LinearGradient meshFor(Brightness brightness) => meshWarm;
}
