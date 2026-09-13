import 'package:flutter/foundation.dart';

/// Lightweight per-section unread / event badges for Home shell.
class SectionNotify extends ChangeNotifier {
  int chat = 0;
  int activity = 0;
  int assets = 0;
  int agents = 0;
  int home = 0;

  void bump(String section, {int by = 1}) {
    switch (section) {
      case 'chat':
        chat += by;
        break;
      case 'activity':
        activity += by;
        break;
      case 'assets':
        assets += by;
        break;
      case 'agents':
        agents += by;
        break;
      case 'home':
        home += by;
        break;
      default:
        return;
    }
    notifyListeners();
  }

  void clear(String section) {
    switch (section) {
      case 'chat':
        chat = 0;
        break;
      case 'activity':
        activity = 0;
        break;
      case 'assets':
        assets = 0;
        break;
      case 'agents':
        agents = 0;
        break;
      case 'home':
        home = 0;
        break;
      default:
        return;
    }
    notifyListeners();
  }

  int countForTab(int tab) {
    switch (tab) {
      case 0:
        return home;
      case 1:
        return chat;
      case 3:
        return activity;
      case 4:
        return assets;
      default:
        return 0;
    }
  }
}
