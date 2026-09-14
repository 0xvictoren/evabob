import 'dart:async';
import 'dart:convert';

import 'package:dynamic_sdk/dynamic_sdk.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../config/env.dart';
import 'evabob_user.dart';
import 'session_store.dart';
// Env used for resolvedAvatarUrl

export 'evabob_user.dart';

/// App login via Dynamic (email OTP). Circle UCW handles wallets separately.
///
/// **Hard session finish:** signed-in only when we have a real Dynamic JWT
/// (or explicit demo mode). No provisional email-only sessions.
class EvabobAuth extends ChangeNotifier {
  /// Session record (JWT, wallet address, email) lives in secure storage.
  /// See SessionStore -- it used to be plain text in SharedPreferences.
  final SessionStore _session = SessionStore();

  EvabobAuth({ApiClient? api}) : _api = api;

  final ApiClient? _api;
  String _resolvedDynamicEnvironmentId = Env.dynamicEnvironmentId;

  EvabobUser? _user;
  bool _ready = false;
  bool _loading = false;
  String? _error;
  bool _demoMode = false;
  bool needsNewOtp = false;
  String? _avatarPath;

  /// Server-relative or absolute avatar URL (Mongo /uploads/…).
  String? _avatarUrl;

  /// Which of the bundled illustrations the user picked (0-based), if any.
  /// Distinct from a custom upload — the render order is upload, then this,
  /// then a deterministic pick from the user id.
  int? _avatarBundleIndex;
  String? _pendingEmail;
  DynamicSDK? _sdk;
  StreamSubscription<UserProfile?>? _userSub;
  StreamSubscription<String?>? _tokenSub;
  StreamSubscription<String?>? _minTokenSub;
  Completer<UserProfile>? _profileWaiter;
  Completer<String>? _tokenWaiter;

  EvabobUser? get user => _user;

  /// Hard finish: demo OR real user with non-empty auth token.
  bool get isSignedIn =>
      _user != null &&
      (_demoMode || (_user!.authToken != null && _user!.authToken!.isNotEmpty));

  bool get isReady => _ready;
  bool get isLoading => _loading;
  bool get isDemoMode => _demoMode;
  String? get error => _error;
  String? get avatarPath => _avatarPath;
  String? get avatarUrl => _avatarUrl;
  int? get avatarBundleIndex => _avatarBundleIndex;
  Widget? get dynamicOverlay => _sdk?.dynamicWidget;

  /// Absolute URL for NetworkImage (API base + path).
  String? get resolvedAvatarUrl {
    final u = _avatarUrl;
    if (u == null || u.isEmpty) return null;
    if (u.startsWith('http://') || u.startsWith('https://')) return u;
    final base = Env.resolveApiBaseUrl().replaceAll(RegExp(r'/$'), '');
    return u.startsWith('/') ? '$base$u' : '$base/$u';
  }

  /// Circle user id mapped from Dynamic subject (JWT sub).
  String get circleUserId =>
      EvabobUser.circleUserIdFrom(_user?.id ?? 'dev-user');

  Future<void> init() async {
    _loading = true;
    notifyListeners();
    try {
      var resolvedAppName = Env.appName;
      if (_api != null) {
        try {
          final publicConfig = await _api
              .get('/v1/config/public')
              .timeout(const Duration(seconds: 5));
          final dynamic = publicConfig['dynamic'];
          if (dynamic is Map) {
            final id = dynamic['environmentId']?.toString().trim();
            if (id != null && id.isNotEmpty) {
              _resolvedDynamicEnvironmentId = id;
            }
          }
          final serverName = publicConfig['appName']?.toString().trim();
          if (serverName != null && serverName.isNotEmpty) {
            resolvedAppName = serverName;
          }
        } catch (e) {
          debugPrint('EvabobAuth: using bundled Dynamic config ($e)');
        }
      }
      if (_resolvedDynamicEnvironmentId.isNotEmpty) {
        _sdk = DynamicSDK.init(
          props: ClientProps(
            environmentId: _resolvedDynamicEnvironmentId,
            appName: resolvedAppName,
            appOrigin: Env.dynamicAppOrigin,
            apiBaseUrl: 'https://app.dynamicauth.com/api/v0',
            logLevel: kDebugMode ? LoggerLevel.debug : LoggerLevel.error,
            debugWebview: kDebugMode,
            debug: kDebugMode ? ClientDebugProps(webview: true) : null,
          ),
        );
        _userSub = _sdk!.auth.authenticatedUserChanges.listen(_onProfile);
        _tokenSub = _sdk!.auth.tokenChanges.listen(_onToken);
        _minTokenSub = _sdk!.auth.minAuthTokenChanges.listen(_onToken);

        // Warm Dynamic WebView bridge before any OTP.
        await Future<void>.delayed(const Duration(milliseconds: 1500));

        final token = _readToken();
        final existing = _sdk!.auth.authenticatedUser;

        if (token != null && token.isNotEmpty) {
          // Hard finish from live SDK token (preferred).
          final live = _sessionFromToken(
            token,
            profile: existing,
            fallbackEmail: null,
          );
          if (live != null) {
            // JWT rebuild always ships smartAccount: '' — keep the cached
            // wallet for the same email so Home can still pull balances.
            final cached = await _session.read();
            final restored = cached != null && cached.isNotEmpty
                ? _userFromCache(cached)
                : null;
            final sameEmail = restored != null &&
                restored.email.isNotEmpty &&
                live.email.isNotEmpty &&
                restored.email.toLowerCase() == live.email.toLowerCase();
            final sameId = restored != null && restored.id == live.id;
            _user = live.copyWith(
              smartAccount: live.smartAccount.isNotEmpty
                  ? live.smartAccount
                  : ((sameEmail || sameId) ? restored.smartAccount : ''),
              handle: (live.handle != null && live.handle!.isNotEmpty)
                  ? live.handle
                  : restored?.handle,
              displayName:
                  live.displayName.isNotEmpty && live.displayName != live.id
                      ? live.displayName
                      : (restored?.displayName ?? live.displayName),
              phone: live.phone ?? restored?.phone,
              phoneLinked: live.phoneLinked || (restored?.phoneLinked ?? false),
              phoneLinkedAt: live.phoneLinkedAt ?? restored?.phoneLinkedAt,
              onboardingRequired:
                  (sameEmail || sameId) ? restored.onboardingRequired : null,
            );
            _demoMode = false;
            await _loadAvatarForUser(live.id);
            await _persist();
          }
        } else {
          // Restore only a previously finished session that still has a JWT.
          final cached = await _session.read();
          if (cached != null && cached.isNotEmpty) {
            final restored = _userFromCache(cached);
            if (restored != null &&
                restored.authToken != null &&
                restored.authToken!.isNotEmpty &&
                _sessionFromToken(
                      restored.authToken!,
                      fallbackEmail: restored.email,
                    ) !=
                    null) {
              _user = restored;
              _demoMode = false;
              await _loadAvatarForUser(restored.id);
            }
          }
        }
      } else if (Env.demoEnabled && Env.autoDemoLogin) {
        _user = EvabobUser.demo('victor@evabob.app', displayName: 'Victor');
        _demoMode = true;
      }
      _ready = true;
    } catch (e, st) {
      debugPrint('EvabobAuth.init: $e\n$st');
      _ready = true;
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  String? _readToken() {
    final t = _sdk?.auth.token;
    if (t != null && t.isNotEmpty) return t;
    final m = _sdk?.auth.minAuthToken;
    if (m != null && m.isNotEmpty) return m;
    return null;
  }

  void _onProfile(UserProfile? profile) {
    if (profile != null &&
        _profileWaiter != null &&
        !_profileWaiter!.isCompleted) {
      _profileWaiter!.complete(profile);
    }
    if (profile == null) return;

    // Never mark signed-in from profile alone — need JWT for hard finish.
    final token = _readToken() ?? _user?.authToken;
    if (token == null || token.isEmpty) {
      debugPrint('EvabobAuth: profile without token yet — waiting for JWT');
      return;
    }
    final session = _sessionFromToken(
      token,
      profile: profile,
      fallbackEmail: _pendingEmail,
    );
    if (session == null) return;
    final switched = _isAccountSwitch(session);
    _user = session.copyWith(
      smartAccount: switched
          ? ''
          : (session.smartAccount.isNotEmpty
              ? session.smartAccount
              : (_user?.smartAccount ?? '')),
      onboardingRequired: switched ? null : _user?.onboardingRequired,
    );
    _demoMode = false;
    _loadAvatarForUser(_user!.id);
    _persist();
    notifyListeners();
  }

  void _onToken(String? token) {
    if (token == null || token.isEmpty) return;
    if (_tokenWaiter != null && !_tokenWaiter!.isCompleted) {
      _tokenWaiter!.complete(token);
    }

    final profile = _sdk?.auth.authenticatedUser;
    final session = _sessionFromToken(
      token,
      profile: profile,
      fallbackEmail: _pendingEmail ?? _user?.email,
    );
    if (session == null) return;

    final switched = _isAccountSwitch(session);
    // Fresh login / account switch: do not inherit previous wallet address.
    // Same email (or same id) keeps the cached Circle SCA so balances load
    // even when Dynamic rotates the JWT `sub`.
    _user = session.copyWith(
      smartAccount: switched
          ? ''
          : (session.smartAccount.isNotEmpty
              ? session.smartAccount
              : (_user?.smartAccount ?? '')),
      onboardingRequired: switched ? null : _user?.onboardingRequired,
    );
    _demoMode = false;
    _loadAvatarForUser(_user!.id);
    _persist();
    notifyListeners();
  }

  Future<bool> sendEmailCode(String email) async {
    _error = null;
    needsNewOtp = false;
    _loading = true;
    notifyListeners();
    try {
      final trimmed = email.trim().toLowerCase();
      if (trimmed.isEmpty || !trimmed.contains('@')) {
        _error = 'Enter a valid email';
        return false;
      }
      _pendingEmail = trimmed;
      if (_sdk != null) {
        await Future<void>.delayed(const Duration(milliseconds: 400));
        await _sdk!.auth.email.sendOTP(trimmed);
      } else {
        if (!Env.demoEnabled) {
          _error = 'Sign-in is not configured for this build.';
          return false;
        }
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
      return true;
    } catch (e, st) {
      debugPrint('sendEmailCode: $e\n$st');
      _error = _friendly(e);
      return false;
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  Future<bool> resendEmailCode() async {
    final email = _pendingEmail;
    if (email == null) {
      _error = 'Enter your email first';
      notifyListeners();
      return false;
    }
    try {
      if (_sdk != null) {
        try {
          await _sdk!.auth.email.resendOTP();
        } catch (_) {
          await _sdk!.auth.email.sendOTP(email);
        }
      }
      _error = null;
      needsNewOtp = false;
      notifyListeners();
      return true;
    } catch (e) {
      return sendEmailCode(email);
    }
  }

  Future<bool> loginWithEmailCode({
    required String email,
    required String code,
  }) async {
    _error = null;
    needsNewOtp = false;
    _loading = true;
    notifyListeners();
    try {
      final trimmedCode = code.trim().replaceAll(RegExp(r'\s+'), '');
      final trimmedEmail = email.trim().toLowerCase();
      if (trimmedCode.length < 4) {
        _error = 'Enter the 6-digit code';
        return false;
      }

      // No Dynamic SDK → demo-only path (dev builds without env id).
      if (_sdk == null) {
        if (!Env.demoEnabled) {
          _error = 'Sign-in is not configured for this build.';
          return false;
        }
        _user = EvabobUser(
          id: EvabobUser.circleUserIdFrom(trimmedEmail),
          email: trimmedEmail,
          displayName: EvabobUser.displayNameFrom(
            username: null,
            email: trimmedEmail,
            phone: null,
          ),
          smartAccount: '',
          authToken: 'demo-token',
        );
        _demoMode = true;
        HapticFeedback.lightImpact();
        return true;
      }

      _pendingEmail = trimmedEmail;
      _profileWaiter = Completer<UserProfile>();
      _tokenWaiter = Completer<String>();

      debugPrint('EvabobAuth: verifying OTP…');
      await _sdk!.auth.email.verifyOTP(trimmedCode);
      debugPrint(
        'EvabobAuth: verifyOTP ok '
        'profile=${_sdk!.auth.authenticatedUser != null} '
        'token=${(_readToken() ?? '').isNotEmpty}',
      );

      // HARD FINISH: must obtain a real Dynamic JWT (not provisional email id).
      final session = await _awaitHardSession(
        fallbackEmail: trimmedEmail,
        timeout: const Duration(seconds: 30),
      );

      if (session == null ||
          session.authToken == null ||
          session.authToken!.isEmpty) {
        debugPrint(
          'EvabobAuth: hard session failed '
          'profile=${_sdk!.auth.authenticatedUser} '
          'token=${_sdk!.auth.token} min=${_sdk!.auth.minAuthToken}',
        );
        _error = 'Sign-in did not complete. Request a new code and try again. '
            'Stay on this screen until the session loads.';
        needsNewOtp = true;
        return false;
      }

      _user = session;
      _demoMode = false;
      await _persist();
      HapticFeedback.lightImpact();
      debugPrint(
        'EvabobAuth: hard finish ok id=${session.id} email=${session.email}',
      );
      return true;
    } catch (e, st) {
      debugPrint('loginWithEmailCode: $e\n$st');
      _error = _friendly(e);
      needsNewOtp = _isInvalidOtp(e);
      return false;
    } finally {
      _profileWaiter = null;
      _tokenWaiter = null;
      _loading = false;
      notifyListeners();
    }
  }

  /// Wait until Dynamic publishes a JWT with `sub`. Profile enriches email only.
  Future<EvabobUser?> _awaitHardSession({
    required String fallbackEmail,
    required Duration timeout,
  }) async {
    final deadline = DateTime.now().add(timeout);

    while (DateTime.now().isBefore(deadline)) {
      final token = _readToken();
      if (token != null && token.isNotEmpty) {
        final session = _sessionFromToken(
          token,
          profile: _sdk?.auth.authenticatedUser,
          fallbackEmail: fallbackEmail,
        );
        if (session != null &&
            session.authToken != null &&
            session.authToken!.isNotEmpty &&
            session.id.isNotEmpty) {
          return session;
        }
      }

      // Already finished via stream listeners.
      if (isSignedIn && _user != null) return _user;

      try {
        await Future.any<void>([
          if (_tokenWaiter != null && !_tokenWaiter!.isCompleted)
            _tokenWaiter!.future.then((_) {}),
          if (_profileWaiter != null && !_profileWaiter!.isCompleted)
            _profileWaiter!.future.then((_) {}),
          Future<void>.delayed(const Duration(milliseconds: 250)),
        ]);
      } catch (_) {}

      // Recreate token waiter if it completed with nothing usable.
      if (_tokenWaiter != null &&
          _tokenWaiter!.isCompleted &&
          (_readToken() == null || _readToken()!.isEmpty)) {
        _tokenWaiter = Completer<String>();
      }
    }

    final token = _readToken();
    if (token == null || token.isEmpty) return null;
    return _sessionFromToken(
      token,
      profile: _sdk?.auth.authenticatedUser,
      fallbackEmail: fallbackEmail,
    );
  }

  /// Build a finished session from JWT. Returns null if `sub` missing.
  EvabobUser? _sessionFromToken(
    String token, {
    UserProfile? profile,
    String? fallbackEmail,
  }) {
    final tokenEnvironment = _jwtClaim(token, 'environment_id');
    if (tokenEnvironment != null &&
        _resolvedDynamicEnvironmentId.isNotEmpty &&
        tokenEnvironment != _resolvedDynamicEnvironmentId) {
      debugPrint(
        'EvabobAuth: ignoring a session from the previous Dynamic environment',
      );
      return null;
    }
    final fromJwt = _userFromJwt(token, fallbackEmail: fallbackEmail);
    if (fromJwt == null) return null;

    if (profile == null) {
      return fromJwt.copyWith(
        email: fromJwt.email.isNotEmpty
            ? fromJwt.email
            : (fallbackEmail ?? fromJwt.email),
      );
    }

    final mapped = _mapProfile(profile, token: token);
    // Prefer Dynamic userId/sub from JWT for stable Circle id.
    return mapped.copyWith(
      id: fromJwt.id.isNotEmpty ? fromJwt.id : mapped.id,
      email: mapped.email.isNotEmpty
          ? mapped.email
          : (fromJwt.email.isNotEmpty ? fromJwt.email : (fallbackEmail ?? '')),
      authToken: token,
      phone: mapped.phone ?? fromJwt.phone,
    );
  }

  Future<void> continueAsDemo([String name = 'Victor']) async {
    if (!Env.demoEnabled) return;
    _user = EvabobUser.demo('$name@evabob.app', displayName: name)
        .copyWith(authToken: 'demo-token');
    _demoMode = true;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('evabob_demo', true);
    await _persist();
    notifyListeners();
  }

  Future<void> signOut() async {
    final priorId = _user?.id;
    _user = null;
    _demoMode = false;
    _avatarPath = null;
    _avatarUrl = null;
    _avatarBundleIndex = null;
    try {
      await _sdk?.auth.logout();
    } catch (_) {}
    final prefs = await SharedPreferences.getInstance();
    // Clears secure storage and any legacy plain-text copy.
    await _session.clear();
    await prefs.remove('evabob_demo');
    // Do not wipe other users' avatar files; just clear in-memory path.
    if (priorId != null) {
      // keep disk avatar_{id}.jpg for next login of same user
    }
    notifyListeners();
  }

  void bindExternalWallet(String address) {
    if (_user == null) return;
    if (!address.startsWith('0x') || address.length != 42) return;
    // Never bind a wallet that already belongs to a different persisted user.
    _user = _user!.copyWith(smartAccount: address);
    _persist();
    notifyListeners();
  }

  /// Clear linked wallet address (used when switching accounts).
  void clearBoundWallet() {
    if (_user == null) return;
    _user = _user!.copyWith(smartAccount: '');
    _persist();
    notifyListeners();
  }

  Future<void> setAvatarPath(String? path) async {
    _avatarPath = path;
    final prefs = await SharedPreferences.getInstance();
    final key = _avatarPrefsKey(_user?.id);
    if (path == null || path.isEmpty) {
      await prefs.remove(key);
      await prefs.remove('evabob_avatar_path'); // legacy
    } else {
      await prefs.setString(key, path);
    }
    notifyListeners();
  }

  Future<void> setAvatarUrl(String? url) async {
    _avatarUrl = url;
    final prefs = await SharedPreferences.getInstance();
    final key = _avatarUrlPrefsKey(_user?.id);
    if (url == null || url.isEmpty) {
      await prefs.remove(key);
    } else {
      await prefs.setString(key, url);
    }
    notifyListeners();
  }

  /// Picks one of the bundled illustrations. Clears any custom upload so the
  /// choice is unambiguous — a user who picks a bundle avatar is choosing it
  /// over whatever photo they had.
  Future<void> setAvatarBundleIndex(int? index) async {
    _avatarBundleIndex = index;
    if (index != null) {
      _avatarPath = null;
      _avatarUrl = null;
    }
    final prefs = await SharedPreferences.getInstance();
    final key = _avatarBundlePrefsKey(_user?.id);
    if (index == null) {
      await prefs.remove(key);
    } else {
      await prefs.setInt(key, index);
      await prefs.remove(_avatarPrefsKey(_user?.id));
      await prefs.remove(_avatarUrlPrefsKey(_user?.id));
    }
    notifyListeners();
  }

  String _avatarPrefsKey(String? userId) =>
      'evabob_avatar_path_${userId ?? 'guest'}';

  String _avatarUrlPrefsKey(String? userId) =>
      'evabob_avatar_url_${userId ?? 'guest'}';

  String _avatarBundlePrefsKey(String? userId) =>
      'evabob_avatar_bundle_${userId ?? 'guest'}';

  Future<void> _loadAvatarForUser(String? userId) async {
    final prefs = await SharedPreferences.getInstance();
    final keyed = prefs.getString(_avatarPrefsKey(userId));
    if (keyed != null && keyed.isNotEmpty) {
      _avatarPath = keyed;
    } else {
      _avatarPath = prefs.getString('evabob_avatar_path');
    }
    _avatarUrl = prefs.getString(_avatarUrlPrefsKey(userId));
    _avatarBundleIndex = prefs.getInt(_avatarBundlePrefsKey(userId));
  }

  Future<void> setPhone(String? phone,
      {bool linked = false, String? linkedAt}) async {
    if (_user == null) return;
    if (_user!.phoneLinked && !linked) {
      // Permanent link — ignore unsolicited changes
      return;
    }
    final cleaned = phone?.trim() ?? '';
    _user = cleaned.isEmpty
        ? _user!.copyWith(clearPhone: true, phoneLinked: false)
        : _user!.copyWith(
            phone: cleaned,
            phoneLinked: linked || _user!.phoneLinked,
            phoneLinkedAt: linkedAt ?? _user!.phoneLinkedAt,
          );
    await _persist();
    notifyListeners();
  }

  Future<void> setDisplayName(String name) async {
    if (_user == null) return;
    final n = name.trim();
    if (n.isEmpty) return;
    // Display name only — never touches @handle.
    _user = _user!.copyWith(displayName: n);
    await _persist();
    notifyListeners();
  }

  Future<void> setHandle(String handle) async {
    if (_user == null) return;
    final h = handle.trim().replaceAll('@', '').toLowerCase();
    if (h.isEmpty) return;
    _user = _user!.copyWith(handle: h);
    await _persist();
    notifyListeners();
  }

  Future<void> setOnboardingRequired(bool required) async {
    if (_user == null) return;
    _user = _user!.copyWith(onboardingRequired: required);
    await _persist();
    notifyListeners();
  }

  EvabobUser _mapProfile(UserProfile profile, {String? token}) {
    var email = profile.email?.trim() ?? '';
    if (email.isEmpty) {
      for (final c in profile.verifiedCredentials) {
        if (c.format == JwtVerifiedCredentialFormatEnum.email) {
          final e = c.email ?? c.publicIdentifier;
          if (e != null && e.contains('@')) {
            email = e;
            break;
          }
        }
      }
    }
    final id = (profile.userId?.isNotEmpty == true)
        ? profile.userId!
        : profile.sessionId;
    // Keep existing display/handle if user already customized them.
    final display = (_user?.displayName.isNotEmpty == true)
        ? _user!.displayName
        : EvabobUser.displayNameFrom(
            username: null, // don't force Dynamic alias into display forever
            email: email.isNotEmpty ? email : null,
            phone: profile.phoneNumber,
          );
    final handle = (_user?.handle != null && _user!.handle!.isNotEmpty)
        ? _user!.handle
        : EvabobUser.defaultHandleFromEmail(email);
    return EvabobUser(
      id: id,
      email: email,
      displayName: display,
      handle: handle,
      smartAccount: _user?.smartAccount ?? '',
      authToken: token,
      phone: profile.phoneNumber?.trim().isNotEmpty == true
          ? profile.phoneNumber!.trim()
          : _user?.phone,
    );
  }

  EvabobUser? _userFromJwt(String token, {String? fallbackEmail}) {
    final sub = _jwtClaim(token, 'sub');
    if (sub == null || sub.isEmpty) return null;
    final email = _jwtClaim(token, 'email') ?? fallbackEmail ?? '';
    final sameEmail = _user != null &&
        _user!.email.isNotEmpty &&
        email.isNotEmpty &&
        _user!.email.toLowerCase() == email.toLowerCase();
    final sameId = _user?.id == sub;
    return EvabobUser(
      id: sub,
      email: email,
      displayName: EvabobUser.displayNameFrom(
        username: null,
        email: email.isNotEmpty ? email : null,
        phone: null,
      ),
      handle: EvabobUser.defaultHandleFromEmail(email),
      smartAccount: (sameEmail || sameId) ? (_user?.smartAccount ?? '') : '',
      authToken: token,
      phone: _user?.phone,
    );
  }

  /// True only when the signed-in *person* changed — not when Dynamic
  /// rotates `sub` for the same email (that used to wipe the wallet).
  bool _isAccountSwitch(EvabobUser session) {
    if (_user == null) return false;
    final prevEmail = _user!.email.trim().toLowerCase();
    final nextEmail = session.email.trim().toLowerCase();
    if (prevEmail.isNotEmpty && nextEmail.isNotEmpty) {
      return prevEmail != nextEmail;
    }
    return _user!.id != session.id;
  }

  EvabobUser? _userFromCache(String cached) {
    final parts = cached.split('\u001f');
    if (parts.length < 4 || parts[0].isEmpty) return null;
    final token = parts.length > 4 && parts[4].isNotEmpty ? parts[4] : null;
    if (token == null || token.isEmpty) return null;
    final email = parts.length > 1 ? parts[1] : '';
    final phoneLinked = parts.length > 7 && parts[7] == '1';
    final phoneLinkedAt =
        parts.length > 8 && parts[8].isNotEmpty ? parts[8] : null;
    return EvabobUser(
      id: parts[0],
      email: email,
      displayName: parts.length > 2 ? parts[2] : 'User',
      smartAccount: parts.length > 3 ? parts[3] : '',
      authToken: token,
      phone: parts.length > 5 && parts[5].isNotEmpty ? parts[5] : null,
      // v5: optional handle at index 6 (older caches fall back to email)
      handle: parts.length > 6 && parts[6].isNotEmpty
          ? parts[6]
          : EvabobUser.defaultHandleFromEmail(email),
      phoneLinked: phoneLinked,
      phoneLinkedAt: phoneLinkedAt,
      onboardingRequired:
          parts.length > 9 && parts[9].isNotEmpty ? parts[9] == '1' : null,
    );
  }

  /// Merge server profile fields (phone lock, handle, wallet) after session sync.
  Future<void> applyServerProfile(Map<String, dynamic> user) async {
    if (_user == null) return;
    final phone = user['phone']?.toString();
    final linked = user['phoneLinked'] == true ||
        (user['phoneLinkedAt']?.toString().isNotEmpty == true);
    final linkedAt = user['phoneLinkedAt']?.toString();
    final handle = user['handle']?.toString();
    final display = user['displayName']?.toString();
    final evm = user['evmAddress']?.toString();
    final onboardingRequired = user['onboardingRequired'];
    final nextSmart = (evm != null && evm.startsWith('0x') && evm.length == 42)
        ? evm
        : _user!.smartAccount;
    final nextHandle = handle?.isNotEmpty == true ? handle : _user!.handle;
    final nextDisplay =
        display?.isNotEmpty == true ? display : _user!.displayName;
    final nextPhone = phone?.isNotEmpty == true ? phone : _user!.phone;
    final nextLinked = linked || _user!.phoneLinked;
    final nextLinkedAt = linkedAt ?? _user!.phoneLinkedAt;
    final nextOnboardingRequired = onboardingRequired is bool
        ? onboardingRequired
        : _user!.onboardingRequired;
    final unchanged = nextSmart == _user!.smartAccount &&
        nextHandle == _user!.handle &&
        nextDisplay == _user!.displayName &&
        nextPhone == _user!.phone &&
        nextLinked == _user!.phoneLinked &&
        nextLinkedAt == _user!.phoneLinkedAt &&
        nextOnboardingRequired == _user!.onboardingRequired;
    if (unchanged) return;
    _user = _user!.copyWith(
      phone: nextPhone,
      phoneLinked: nextLinked,
      phoneLinkedAt: nextLinkedAt,
      handle: nextHandle,
      displayName: nextDisplay,
      smartAccount: nextSmart,
      onboardingRequired: nextOnboardingRequired,
    );
    await _persist();
    notifyListeners();
  }

  Map<String, dynamic>? _jwtPayload(String token) {
    try {
      final parts = token.split('.');
      if (parts.length < 2) return null;
      var payload = parts[1].replaceAll('-', '+').replaceAll('_', '/');
      final mod = payload.length % 4;
      if (mod > 0) payload += '=' * (4 - mod);
      final decoded = jsonDecode(utf8.decode(base64.decode(payload)));
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {}
    return null;
  }

  String? _jwtClaim(String token, String key) {
    final v = _jwtPayload(token)?[key];
    if (v == null) return null;
    final s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  bool _isInvalidOtp(Object e) {
    final s = e.toString().toLowerCase();
    return s.contains('invalid_email_verification') ||
        s.contains('verification process is invalid') ||
        s.contains('please start again') ||
        s.contains('expired') ||
        (s.contains('invalid') && s.contains('otp')) ||
        s.contains('incorrect');
  }

  String _friendly(Object e) {
    final raw = e.toString();
    final lower = raw.toLowerCase();
    if (_isInvalidOtp(e)) {
      return 'That code is no longer valid. Tap “Send new code”.';
    }
    if (lower.contains('network') ||
        lower.contains('socket') ||
        lower.contains('timeout') ||
        lower.contains('failed host lookup')) {
      return 'Cannot reach Evabob right now. Check your connection and try again.';
    }
    if (lower.contains('webview') || raw.length > 160) {
      return 'Sign-in failed. Request a new code and try again.';
    }
    return raw
        .replaceFirst(RegExp(r'^Exception:\s*'), '')
        .split('\n')
        .first
        .trim();
  }

  Future<void> _persist() async {
    final u = _user;
    if (u == null) return;
    // Never persist a half-finished session without JWT.
    if (!_demoMode && (u.authToken == null || u.authToken!.isEmpty)) return;
    await _session.write(
      [
        u.id,
        u.email,
        u.displayName,
        u.smartAccount,
        u.authToken ?? '',
        u.phone ?? '',
        u.handle ?? '',
        // v6: permanent phone link flags (must survive cold start)
        u.phoneLinked ? '1' : '0',
        u.phoneLinkedAt ?? '',
        u.onboardingRequired == null ? '' : (u.onboardingRequired! ? '1' : '0'),
      ].join('\u001f'),
    );
  }

  @override
  void dispose() {
    _userSub?.cancel();
    _tokenSub?.cancel();
    _minTokenSub?.cancel();
    super.dispose();
  }
}
