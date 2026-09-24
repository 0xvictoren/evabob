import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'evabob_colors.dart';
import 'evabob_tokens.dart';

/// Offline-safe theme matching the light-blue Figma system.
///
/// Numans is bundled with the app, while wallet addresses and hashes remain
/// monospace so truncated values stay easy to compare.
class EvabobTheme {
  static ThemeData light() => _build();

  static ThemeData dark() => _build();

  static ThemeData _build() {
    final surface = EvabobColors.pageBg;
    const onSurface = EvabobColors.nearBlack;

    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      scaffoldBackgroundColor: surface,
      fontFamily: 'Numans',
      colorScheme: ColorScheme(
        brightness: Brightness.light,
        primary: EvabobColors.emerald,
        onPrimary: EvabobColors.onPrimary,
        secondary: EvabobColors.emeraldSoft,
        onSecondary: EvabobColors.ink,
        surface: EvabobColors.sheet,
        onSurface: onSurface,
        error: EvabobColors.alert,
        onError: EvabobColors.onPrimary,
      ),
    );

    return base.copyWith(
      visualDensity: VisualDensity.standard,
      splashFactory: InkSparkle.splashFactory,
      textTheme: base.textTheme
          .apply(
            bodyColor: onSurface,
            displayColor: onSurface,
          )
          .copyWith(
            titleLarge: const TextStyle(
              fontSize: 22,
              height: 28 / 22,
              letterSpacing: -0.2,
              fontWeight: FontWeight.w400,
              color: onSurface,
              fontFamily: 'Numans',
            ),
            headlineSmall: const TextStyle(
              fontSize: 22,
              height: 28 / 22,
              letterSpacing: -0.2,
              fontWeight: FontWeight.w400,
              color: onSurface,
              fontFamily: 'Numans',
            ),
          ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        systemOverlayStyle: SystemUiOverlayStyle.dark,
        titleTextStyle: TextStyle(
          fontSize: 22,
          height: 28 / 22,
          letterSpacing: -0.2,
          fontWeight: FontWeight.w400,
          color: onSurface,
          fontFamily: 'Numans',
        ),
        iconTheme: IconThemeData(color: onSurface),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          // Primary CTA contract: #00B5FF fill with white text.
          backgroundColor: EvabobColors.emerald,
          foregroundColor: EvabobColors.onPrimary,
          elevation: 0,
          minimumSize: const Size(44, 56),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
          shape: const StadiumBorder(),
          textStyle: const TextStyle(
            fontWeight: FontWeight.w400,
            fontSize: 14,
            height: 18 / 14,
            letterSpacing: -0.1,
            fontFamily: 'Numans',
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: EvabobColors.navyMuted,
        ),
      ),
      // Soft-blue field with a brand-blue focus outline.
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: EvabobColors.creamDeep,
        hintStyle: const TextStyle(color: EvabobColors.chalk),
        labelStyle: const TextStyle(color: EvabobColors.navyMuted),
        helperStyle: const TextStyle(color: EvabobColors.chalk),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: EvabobColors.emerald),
        ),
        errorStyle: const TextStyle(color: EvabobColors.alert),
      ),
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith(
          (s) => s.contains(WidgetState.selected)
              ? EvabobColors.emerald
              : Colors.transparent,
        ),
        checkColor: const WidgetStatePropertyAll(EvabobColors.onPrimary),
        side: const BorderSide(color: EvabobColors.navyMuted),
      ),
      dividerColor: EvabobColors.hairline,
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: EvabobColors.creamDeep,
        side: BorderSide.none,
        shape: const StadiumBorder(),
        labelStyle: Type.body.copyWith(color: EvabobColors.nearBlack),
        secondaryLabelStyle: const TextStyle(color: EvabobColors.onPrimary),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: EvabobColors.creamDeep,
        contentTextStyle: TextStyle(color: EvabobColors.nearBlack),
        behavior: SnackBarBehavior.floating,
      ),
      dialogTheme: const DialogThemeData(
        backgroundColor: EvabobColors.sheet,
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: EvabobColors.sheet,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
      ),
      dividerTheme: const DividerThemeData(
        color: EvabobColors.hairline,
        thickness: 1,
        space: 1,
      ),
      iconTheme: const IconThemeData(color: EvabobColors.ink, size: 22),
    );
  }

  static TextStyle get amountDisplay => const TextStyle(
        fontSize: 48,
        fontWeight: FontWeight.w400,
        color: EvabobColors.nearBlack,
        fontFamily: 'Numans',
        fontFeatures: [FontFeature.tabularFigures()],
        height: 56 / 48,
        letterSpacing: -1,
      );

  static TextStyle get monoRate => const TextStyle(
        fontSize: 10,
        fontWeight: FontWeight.w400,
        color: EvabobColors.navyMuted,
        fontFamily: 'Numans',
        fontFeatures: [FontFeature.tabularFigures()],
        height: 14 / 10,
        letterSpacing: 0.2,
      );
}
