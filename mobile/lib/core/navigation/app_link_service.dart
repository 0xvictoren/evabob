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

  static final _identifier = RegExp(r'^[A-Za-z0-9_.:@-]{1,128}$');
  static const _routesWithoutId = {'activity', 'agents', 'paywall', 'reviews'};
  static const _routesWithId = {
    'send',
    'pay',
    'held',
    'group',
    'agents',
    'task',
    'hold',
    'review',
    'chat',
    'claim',
    'account-recovery',
  };

  /// Converts verified web links into the same route shape as internal links
  /// and rejects unknown routes, extra path data and malformed identifiers.
  static Uri? validated(Uri uri) {
    final scheme = uri.scheme.toLowerCase();
    final isWeb = scheme == 'https' && uri.host.toLowerCase() == 'evabob.app';
    final isCustom = scheme == 'evabob';
    if (!isWeb && !isCustom) return null;
    if (uri.userInfo.isNotEmpty || uri.fragment.isNotEmpty) return null;
    final parts = <String>[
      if (isCustom && uri.host.isNotEmpty) uri.host,
      ...uri.pathSegments,
    ].where((part) => part.isNotEmpty).toList(growable: false);
    if (parts.isEmpty) return null;
    final route = parts.first.toLowerCase();
    if (_routesWithoutId.contains(route) && parts.length == 1) {
      return Uri(scheme: 'evabob', host: route);
    }
    if (!_routesWithId.contains(route)) return null;
    String? id = parts.length == 2 ? parts[1] : null;
    if (route == 'claim' && (id == null || id.isEmpty)) {
      id = uri.queryParameters['transferId'] ?? uri.queryParameters['token'];
    }
    if (id == null || !_identifier.hasMatch(id)) return null;
    return Uri(scheme: 'evabob', host: route, pathSegments: [id]);
  }

  void init() {
    _subscription ??= _links.uriLinkStream.listen(
      (uri) {
        final safe = validated(uri);
        if (safe == null) return;
        _pending = safe;
        notifyListeners();
      },
      onError: (Object error) => debugPrint('app link: $error'),
    );
  }

  /// Opens an in-app link, e.g. from a tapped notification. Same handling as
  /// a link from outside the app.
  void open(Uri uri) {
    final safe = validated(uri);
    if (safe == null) return;
    _pending = safe;
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
