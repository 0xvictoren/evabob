import 'package:flutter/material.dart';

import '../widgets/motion.dart';
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
    final onSurface = EvabobColors.nearBlack;

    final base = ThemeData(
      useMaterial3: true,
      brightness: EvabobColors.dark ? Brightness.dark : Brightness.light,
      scaffoldBackgroundColor: surface,
      fontFamily: 'Numans',
      colorScheme: ColorScheme(
        brightness: EvabobColors.dark ? Brightness.dark : Brightness.light,
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
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: EvabobPageTransitionsBuilder(),
          TargetPlatform.fuchsia: EvabobPageTransitionsBuilder(),
          TargetPlatform.linux: EvabobPageTransitionsBuilder(),
          TargetPlatform.windows: EvabobPageTransitionsBuilder(),
          // iPhones are left out on purpose: they keep their own slide
          // and, with it, the swipe-back gesture.
        },
      ),
      textTheme: base.textTheme
          .apply(
            bodyColor: onSurface,
            displayColor: onSurface,
          )
          .copyWith(
            titleLarge: TextStyle(
              fontSize: 22,
              height: 28 / 22,
              letterSpacing: -0.2,
              fontWeight: FontWeight.w400,
              color: onSurface,
              fontFamily: 'Numans',
            ),
            headlineSmall: TextStyle(
              fontSize: 22,
              height: 28 / 22,
              letterSpacing: -0.2,
              fontWeight: FontWeight.w400,
              color: onSurface,
              fontFamily: 'Numans',
            ),
          ),
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        systemOverlayStyle: EvabobColors.dark
            ? SystemUiOverlayStyle.light
            : SystemUiOverlayStyle.dark,
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
            fontSize: 15,
            height: 20 / 15,
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
        hintStyle: TextStyle(color: EvabobColors.chalk),
        labelStyle: TextStyle(color: EvabobColors.navyMuted),
        floatingLabelStyle: TextStyle(color: EvabobColors.emeraldDeep),
        helperStyle: TextStyle(
          color: EvabobColors.chalk,
          fontSize: 12,
          height: 16 / 12,
        ),
        helperMaxLines: 3,
        errorMaxLines: 3,
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
        side: BorderSide(color: EvabobColors.navyMuted),
      ),
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: ButtonStyle(
          // A soft track with a filled choice, not a black outline.
          side: const WidgetStatePropertyAll(BorderSide.none),
          shape: const WidgetStatePropertyAll(StadiumBorder()),
          backgroundColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected)
                ? EvabobColors.emerald
                : EvabobColors.sheet,
          ),
          foregroundColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.selected)
                ? EvabobColors.onPrimary
                : EvabobColors.navyMuted,
          ),
          minimumSize: const WidgetStatePropertyAll(Size(44, 48)),
          textStyle: const WidgetStatePropertyAll(
            TextStyle(fontSize: 15, height: 20 / 15, fontFamily: 'Numans'),
          ),
        ),
      ),
      dividerColor: EvabobColors.hairline,
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: EvabobColors.creamDeep,
        side: BorderSide.none,
        shape: const StadiumBorder(),
        // Chips do not inherit the app font, so it is named here; without
        // it every chip was drawn in the phone's own typeface.
        labelStyle: Type.body
            .copyWith(color: EvabobColors.nearBlack, fontFamily: 'Numans'),
        secondaryLabelStyle: const TextStyle(
            color: EvabobColors.onPrimary, fontFamily: 'Numans'),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: EvabobColors.creamDeep,
        contentTextStyle: TextStyle(
          color: EvabobColors.nearBlack,
          fontSize: 13,
          height: 18 / 13,
          fontFamily: 'Numans',
        ),
        behavior: SnackBarBehavior.floating,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(14)),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: EvabobColors.sheet,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(20)),
        ),
      ),
      listTileTheme: ListTileThemeData(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(12)),
        ),
        titleTextStyle: TextStyle(
          fontSize: 15,
          height: 20 / 15,
          letterSpacing: -0.1,
          color: EvabobColors.ink,
          fontFamily: 'Numans',
        ),
        subtitleTextStyle: TextStyle(
          fontSize: 12,
          height: 16 / 12,
          letterSpacing: 0.1,
          color: EvabobColors.inkMuted,
          fontFamily: 'Numans',
        ),
      ),
      // Every other button is a pill; these were rounded squares.
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: EvabobColors.emerald,
        foregroundColor: EvabobColors.onPrimary,
        elevation: 2,
        focusElevation: 2,
        hoverElevation: 3,
        highlightElevation: 1,
        shape: const StadiumBorder(),
        extendedTextStyle: const TextStyle(
          fontSize: 15,
          height: 20 / 15,
          letterSpacing: -0.1,
          fontFamily: 'Numans',
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: EvabobColors.sheet,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
      ),
      dividerTheme: DividerThemeData(
        color: EvabobColors.hairline,
        thickness: 1,
        space: 1,
      ),
      iconTheme: IconThemeData(color: EvabobColors.ink, size: 22),
    );
  }

  static TextStyle get amountDisplay => TextStyle(
        fontSize: 48,
        fontWeight: FontWeight.w400,
        color: EvabobColors.nearBlack,
        fontFamily: 'Numans',
        fontFeatures: [FontFeature.tabularFigures()],
        height: 56 / 48,
        letterSpacing: -1,
      );

  static TextStyle get monoRate => TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w400,
        color: EvabobColors.navyMuted,
        fontFamily: 'Numans',
        fontFeatures: [FontFeature.tabularFigures()],
        height: 16 / 12,
        letterSpacing: 0.1,
      );
}
