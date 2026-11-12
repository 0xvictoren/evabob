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

  /// Dark mode. Set by `ThemeController`; every neutral below follows it,
  /// so a screen that reads its colours from here is dark without knowing.
  ///
  /// Names say what a colour is for, not what it looks like: [ink] is text,
  /// [sheet] is a card, [pageBg] is the page. [white] and [black] are the
  /// two that never change — white is what sits on the brand colour.
  static bool dark = false;

  // Primitive colors. [blue] and [blueSoft] keep their names for the existing
  // call sites but follow the chosen theme.
  static Color get blue => palette.base;
  static Color get blueSoft => dark
      ? Color.alphaBlend(palette.base.withAlpha(0x38), _darkSheet)
      : palette.lightDark;
  static const white = Color(0xFFFFFFFF);
  static const black = Color(0xFF0B1620);
  static Color get slate => dark ? _darkMuted : _slate;

  static const _slate = Color(0xFF5A6B78);
  static const _darkPage = Color(0xFF0B1620);
  static const _darkSheet = Color(0xFF15232E);
  static const _darkInk = Color(0xFFF1F6F9);
  static const _darkMuted = Color(0xFFA3B3BE);
  static const _darkTertiary = Color(0xFF8A9BA7);
  static const _darkHairline = Color(0xFF243541);

  // Semantic colors.
  static Color get primary => blue;
  static const onPrimary = white;
  static Color get pageBg => dark ? _darkPage : palette.light;
  static Color get sheet => dark ? _darkSheet : white;
  static Color get ink => dark ? _darkInk : black;
  static Color get inkMuted => slate;
  static Color get inkTertiary => dark ? _darkTertiary : const Color(0xFF64727E);
  static Color get hairline => dark ? _darkHairline : const Color(0xFFE6EBEF);
  static Color get lightDark => blueSoft;
  static const moneyIn = Color(0xFF01FFA6);

  // Surface aliases used by the existing feature layer.
  static Color get mint => sheet;
  static Color get creamDeep => pageBg;
  static Color get sand => dark ? const Color(0xFF2B3D4A) : const Color(0xFFD8E4EA);
  static Color get panel => sheet;
  static Color get cream => pageBg;
  static Color get glass => dark ? const Color(0xF215232E) : const Color(0xF2FFFFFF);
  static Color get glassSoft =>
      dark ? const Color(0xD915232E) : const Color(0xD9FFFFFF);
  static Color get glassTint =>
      dark ? const Color(0xBF15232E) : const Color(0xBFFFFFFF);

  // Foreground aliases.
  static Color get nearBlack => ink;
  static Color get navy => ink;
  static Color get navyMuted => slate;
  static Color get chalk => inkTertiary;
  static Color get forest => ink;

  /// Text and icons on a soft brand fill: darker than the brand colour on a
  /// light page, lighter than it on a dark one.
  static Color get emeraldDeep =>
      dark ? Color.lerp(palette.base, white, 0.35)! : palette.deep;

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
