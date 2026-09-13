import 'package:flutter/material.dart';

/// Evabob's light-blue design tokens.
///
/// The legacy semantic names are intentionally retained so the visual system
/// can move to the Figma palette without changing feature or payment logic.
/// New code should prefer [primary], [onPrimary], [pageBg], [sheet], [ink],
/// and [inkMuted].
class EvabobColors {
  EvabobColors._();

  // Primitive colors.
  static const blue = Color(0xFF00B5FF);
  static const blueSoft = Color(0xFFACE3FF);
  static const white = Color(0xFFFFFFFF);
  static const black = Color(0xFF0B1620);
  static const slate = Color(0xFF5A6B78);

  // Semantic colors.
  static const primary = blue;
  static const onPrimary = white;
  static const pageBg = Color(0xFFF0FAFF);
  static const sheet = white;
  static const ink = black;
  static const inkMuted = slate;
  static const inkTertiary = Color(0xFF64727E);
  static const hairline = Color(0xFFE6EBEF);
  static const lightDark = blueSoft;
  static const moneyIn = Color(0xFF01FFA6);

  // Surface aliases used by the existing feature layer.
  static const mint = white;
  static const creamDeep = pageBg;
  static const sand = Color(0xFFD8E4EA);
  static const panel = white;
  static const cream = pageBg;
  static const glass = Color(0xF2FFFFFF);
  static const glassSoft = Color(0xD9FFFFFF);
  static const glassTint = Color(0xBFFFFFFF);

  // Foreground aliases.
  static const nearBlack = black;
  static const navy = black;
  static const navyMuted = slate;
  static const chalk = inkTertiary;
  static const forest = black;
  static const emeraldDeep = Color(0xFF007EA8);

  // Accent aliases. These keep older call sites on the approved blue.
  static const lime = primary;
  static const emerald = primary;
  static const emeraldSoft = blueSoft;
  static const emeraldGlow = Color(0x2900B5FF);
  static const inkElevated = Color(0xFF163849);

  // Semantic money and alert colors.
  static const success = moneyIn;
  static const danger = Color(0xFFD97706);
  static const alert = Color(0xFFCF3345);

  /// Kept as a gradient token for call-site compatibility, but deliberately
  /// resolves to one flat brand color.
  static const gradientEmerald = LinearGradient(
    colors: [primary, primary],
  );

  static const meshWarm = LinearGradient(colors: [pageBg, pageBg]);

  static const meshDark = meshWarm;

  static LinearGradient meshFor(Brightness brightness) => meshWarm;
}
