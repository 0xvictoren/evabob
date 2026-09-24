import 'package:flutter/material.dart';
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

  ThemeMode _mode = ThemeMode.system;
  ThemeMode get mode => _mode;

  bool get isDark {
    if (_mode == ThemeMode.dark) return true;
    if (_mode == ThemeMode.light) return false;
    return WidgetsBinding.instance.platformDispatcher.platformBrightness ==
        Brightness.dark;
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    switch (raw) {
      case 'dark':
        _mode = ThemeMode.dark;
      case 'light':
        _mode = ThemeMode.light;
      default:
        _mode = ThemeMode.system;
    }
    notifyListeners();
  }

  Future<void> setMode(ThemeMode mode) async {
    _mode = mode;
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
