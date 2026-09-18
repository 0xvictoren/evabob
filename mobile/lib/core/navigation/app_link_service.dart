import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';

/// Captures both cold-start and foreground custom-scheme links.
class AppLinkService extends ChangeNotifier {
  AppLinkService({AppLinks? links}) : _links = links ?? AppLinks();

  final AppLinks _links;
  StreamSubscription<Uri>? _subscription;
  Uri? _pending;

  Uri? get pending => _pending;

  void init() {
    _subscription ??= _links.uriLinkStream.listen(
      (uri) {
        if (uri.scheme.toLowerCase() != 'evabob') return;
        _pending = uri;
        notifyListeners();
      },
      onError: (Object error) => debugPrint('app link: $error'),
    );
  }

  /// Opens an in-app link, e.g. from a tapped notification. Same handling as
  /// a link from outside the app.
  void open(Uri uri) {
    if (uri.scheme.toLowerCase() != 'evabob') return;
    _pending = uri;
    notifyListeners();
  }

  Uri? take() {
    final value = _pending;
    _pending = null;
    return value;
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }
}
