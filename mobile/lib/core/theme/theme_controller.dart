import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'evabob_colors.dart';

/// App-wide theme: light / dark / system, and the colour theme (blue, pink
/// or grey) picked in Profile.
class ThemeController extends ChangeNotifier {
  ThemeController() {
    _load();
  }

  static const _key = 'evabob_theme_mode';
  static const _paletteKey = 'evabob_palette';

  /// Applies the saved colour theme before the first frame, so the app does
  /// not open in blue and then change.
  static Future<void> preloadPalette() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      EvabobColors.palette =
          EvabobPalette.fromName(prefs.getString(_paletteKey));
      // Dark or light before the first frame too, so it never flashes.
      EvabobColors.dark = _darkFor(_modeFrom(prefs.getString(_key)));
    } catch (_) {
      // Stay on the default; the picker still works.
    }
  }

  EvabobPalette get palette => EvabobColors.palette;

  /// Switches the colour theme everywhere at once and remembers it.
  Future<void> setPalette(EvabobPalette palette) async {
    if (palette == EvabobColors.palette) return;
    EvabobColors.palette = palette;
    notifyListeners();
    // Colours are read while widgets build, and many widgets are kept from
    // earlier frames; redraw every one so nothing is left in the old colour.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      void redraw(Element element) {
        element.markNeedsBuild();
        element.visitChildren(redraw);
      }

      WidgetsBinding.instance.rootElement?.visitChildren(redraw);
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_paletteKey, palette.name);
  }

  /// Light unless the person chose dark, or chose to follow their phone.
  ThemeMode _mode = ThemeMode.light;
  ThemeMode get mode => _mode;

  static ThemeMode _modeFrom(String? saved) => switch (saved) {
        'dark' => ThemeMode.dark,
        'system' => ThemeMode.system,
        _ => ThemeMode.light,
      };

  static bool _darkFor(ThemeMode mode) {
    if (mode == ThemeMode.dark) return true;
    if (mode == ThemeMode.light) return false;
    return WidgetsBinding.instance.platformDispatcher.platformBrightness ==
        Brightness.dark;
  }

  bool get isDark => _darkFor(_mode);

  /// "Light", "Dark" or "Same as this phone".
  String get modeLabel => switch (_mode) {
        ThemeMode.dark => 'Dark',
        ThemeMode.system => 'Same as this phone',
        ThemeMode.light => 'Light',
      };

  /// Dark icons in the status bar on a light page, light ones on a dark page.
  static void applySystemBars() {
    final icons = EvabobColors.dark ? Brightness.light : Brightness.dark;
    SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: icons,
      statusBarBrightness: EvabobColors.dark ? Brightness.dark : Brightness.light,
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarIconBrightness: icons,
    ));
  }

  /// Points every colour at the chosen mode and redraws what is on screen:
  /// colours are read while widgets build, and many are kept from earlier
  /// frames.
  void _apply() {
    final dark = isDark;
    if (EvabobColors.dark == dark) return;
    EvabobColors.dark = dark;
    applySystemBars();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      void redraw(Element element) {
        element.markNeedsBuild();
        element.visitChildren(redraw);
      }

      WidgetsBinding.instance.rootElement?.visitChildren(redraw);
    });
  }

  /// The phone switched between light and dark while the app follows it.
  void platformBrightnessChanged() {
    if (_mode != ThemeMode.system) return;
    _apply();
    notifyListeners();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    _mode = _modeFrom(prefs.getString(_key));
    _apply();
    notifyListeners();
  }

  Future<void> setMode(ThemeMode mode) async {
    _mode = mode;
    _apply();
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    final value = switch (mode) {
      ThemeMode.dark => 'dark',
      ThemeMode.light => 'light',
      ThemeMode.system => 'system',
    };
    await prefs.setString(_key, value);
  }

  Future<void> toggleLightDark() async {
    await setMode(isDark ? ThemeMode.light : ThemeMode.dark);
  }
}
