import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../auth/evabob_auth.dart';
import '../config/env.dart';
import '../sound/money_sounds.dart';
import '../../features/wallet/circle_challenge_screen.dart';

String? _circleTxHash(dynamic value, [int depth = 0]) {
  if (depth > 5 || value is! Map) return null;
  const keys = [
    'txHash',
    'hash',
    'transactionHash',
    'sourceTxHash',
    'fundTxHash',
  ];
  for (final key in keys) {
    final candidate = value[key]?.toString();
    if (candidate != null &&
        RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(candidate)) {
      return candidate;
    }
  }
  for (final key in ['result', 'receipt', 'job', 'data', 'meta']) {
    final found = _circleTxHash(value[key], depth + 1);
    if (found != null) return found;
  }
  return null;
}

/// Circle User-Controlled Wallets — **only** path for user funds & signing.
class CircleWalletService extends ChangeNotifier {
  CircleWalletService(this._api, this._auth);

  final ApiClient _api;
  final EvabobAuth _auth;

  String? userToken;
  String? encryptionKey;
  String? walletId;
  String? address;
  String? solanaAddress;
  Map<String, dynamic> addressesByChain = {};
  List<Map<String, dynamic>> wallets = [];
  String? status;
  bool busy = false;
  bool ready = false;

  /// Prefer server-returned App ID (must match Circle Console).
  String? _serverAppId;

  /// Incomplete App Kit bridge/swap jobs the user can Continue.
  List<Map<String, dynamic>> openJobs = [];

  /// One-shot snackbar after an expired PIN is dropped because funds never left.
  String? _fundsIntactNotice;

  String? takeFundsIntactNotice() {
    final m = _fundsIntactNotice;
    _fundsIntactNotice = null;
    return m;
  }

  void _noteFundsIntact(String? message) {
    final m = message?.trim();
    if (m == null || m.isEmpty) return;
    _fundsIntactNotice = m;
  }

  /// challengeId → 0x signature from the most recent WebView run.
  /// Typed-data signatures are delivered *only* to the client that executed
  /// the challenge; Circle's challenge record does not carry them, so App Kit
  /// jobs stall until these are relayed back to the server.
  final Map<String, String> _lastSignatures = {};
  String? _lastVerifiedTxHash;

  String? get lastVerifiedTxHash => _lastVerifiedTxHash;

  /// Circle user id this in-memory session was opened for (isolation guard).
  String? _boundUserId;

  String get appId => (_serverAppId != null && _serverAppId!.isNotEmpty)
      ? _serverAppId!
      : Env.circleWalletsAppId;

  String get _userId => _auth.circleUserId;

  bool get hasSession =>
      userToken != null &&
      encryptionKey != null &&
      walletId != null &&
      address != null;

  /// Show the server-bound SCA immediately (balances / Profile) without
  /// claiming the Circle PIN session is ready.
  void hydrateDisplayAddress(String? addr) {
    if (addr == null || !addr.startsWith('0x') || addr.length != 42) return;
    if (address == addr) return;
    address ??= addr;
    notifyListeners();
  }

  /// Drop all wallet state — call on sign-out and account switch.
  void reset() {
    userToken = null;
    encryptionKey = null;
    walletId = null;
    address = null;
    solanaAddress = null;
    addressesByChain = {};
    wallets = [];
    status = null;
    busy = false;
    ready = false;
    openJobs = [];
    _fundsIntactNotice = null;
    _boundUserId = null;
    _lastVerifiedTxHash = null;
    // Keep _serverAppId — product app id is not user-specific.
    notifyListeners();
  }

  /// Load Circle app id from API so WebView PIN always matches Console.
  Future<void> syncAppIdFromServer() async {
    try {
      final cfg = await _api.get('/v1/circle/config');
      final id = cfg['appId']?.toString().trim();
      if (id != null && id.isNotEmpty) {
        _serverAppId = id;
      }
    } catch (e) {
      debugPrint('syncAppIdFromServer: $e');
    }
  }

  /// If auth identity changed, wipe prior wallet so accounts never share state.
  void _ensureBoundToCurrentUser() {
    final id = _userId;
    if (_boundUserId != null && _boundUserId != id) {
      debugPrint(
        'circle: user changed ($_boundUserId → $id) — resetting wallet session',
      );
      userToken = null;
      encryptionKey = null;
      walletId = null;
      address = null;
      solanaAddress = null;
      addressesByChain = {};
      wallets = [];
      status = null;
      ready = false;
    }
    _boundUserId = id;
  }

  /// Refresh Circle userToken without PIN when wallet already exists.
  Future<bool> refreshSessionOnly() async {
    try {
      _ensureBoundToCurrentUser();
      _api.setUserId(_userId);
      final session = await _api.post('/v1/circle/session', body: {
        'userId': _userId,
      });
      userToken = _str(session['userToken']);
      encryptionKey = _str(session['encryptionKey']);
      return userToken != null && encryptionKey != null;
    } catch (e) {
      debugPrint('refreshSessionOnly: $e');
      return false;
    }
  }

  /// Ensure session + Arc wallet; PIN only for first-time setup (not every send).
  ///
  /// [silent] restores an already-initialized Circle user without prompting
  /// for PIN. Use this on app launch so balances can load immediately.
  Future<bool> ensureReady(BuildContext context, {bool silent = false}) async {
    _ensureBoundToCurrentUser();
    if (ready &&
        address != null &&
        walletId != null &&
        _boundUserId == _userId) {
      // Soft refresh token for operations — no PIN
      if (userToken == null || encryptionKey == null) {
        await refreshSessionOnly();
      }
      return userToken != null && encryptionKey != null;
    }

    final result = await startOnboarding();
    if (!context.mounted) return false;

    if (result.needsChallenge) {
      // Cold-start restore must not pop the PIN sheet — the wallet address
      // still comes from the server session so balances can load.
      if (silent) return ready;
      final ok = await _runChallenges(
        context,
        [
          {
            'step': 'pin_setup',
            'challengeId': result.challengeId,
          }
        ],
        userToken: result.userToken!,
        encryptionKey: result.encryptionKey!,
        appId: result.appId ?? appId,
        title: 'Set wallet PIN',
      );
      if (!ok) return false;
      await completeOnboarding();
    }

    if (result.followUpChallenges.isNotEmpty && context.mounted) {
      await _runChallenges(
        context,
        result.followUpChallenges,
        userToken: userToken!,
        encryptionKey: encryptionKey!,
        appId: appId,
        title: 'Add networks',
      );
      await completeOnboarding(ensureChains: false);
    }

    return ready;
  }

  Future<CircleOnboardResult> startOnboarding() async {
    busy = true;
    status = 'Setting up account…';
    notifyListeners();
    try {
      _ensureBoundToCurrentUser();
      _api.setUserId(_userId);
      await syncAppIdFromServer();

      // Atomic: ensure user + fresh token/key + PIN challenge in one response
      // so challengeId is never paired with a different encryptionKey.
      status = 'Opening secure session…';
      notifyListeners();
      final prep = await _api.post('/v1/circle/prepare-pin', body: {
        'userId': _userId,
      });

      userToken = _str(prep['userToken']);
      encryptionKey = _str(prep['encryptionKey']);
      final resolvedAppId = _str(prep['appId']);
      if (resolvedAppId != null) _serverAppId = resolvedAppId;
      if (userToken == null ||
          userToken!.isEmpty ||
          encryptionKey == null ||
          encryptionKey!.isEmpty) {
        throw Exception('Could not open wallet session');
      }
      if (encryptionKey!.contains(' ')) {
        throw Exception('Encryption key corrupted — retry');
      }

      final followUps = _parseChallenges(prep['followUpChallenges']);

      if (prep['alreadyInitialized'] == true) {
        _applyWalletPayload(prep);
        if (!ready) {
          await completeOnboarding(ensureChains: true);
        }
        return CircleOnboardResult(
          needsChallenge: false,
          address: address,
          walletId: walletId,
          followUpChallenges: followUps,
          userToken: userToken,
          encryptionKey: encryptionKey,
          appId: resolvedAppId ?? appId,
        );
      }

      final cid = _str(prep['challengeId']);
      if (cid == null || cid.isEmpty) {
        await completeOnboarding(ensureChains: true);
        if (ready) {
          return CircleOnboardResult(
            needsChallenge: false,
            address: address,
            walletId: walletId,
            followUpChallenges: followUps,
            userToken: userToken,
            encryptionKey: encryptionKey,
            appId: resolvedAppId ?? appId,
          );
        }
        throw Exception('Wallet setup needs confirmation — try again');
      }

      status = 'Set your wallet PIN';
      notifyListeners();
      return CircleOnboardResult(
        needsChallenge: true,
        challengeId: cid,
        userToken: userToken,
        encryptionKey: encryptionKey,
        appId: resolvedAppId ?? appId,
        followUpChallenges: followUps,
      );
    } catch (e) {
      status = e.toString();
      rethrow;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  void _applyWalletPayload(Map<String, dynamic> data) {
    address = data['primaryAddress']?.toString();
    walletId = data['primaryWalletId']?.toString();
    final addrs = data['addresses'];
    if (addrs is Map) {
      addressesByChain =
          Map<String, dynamic>.from(addrs['byChain'] as Map? ?? {});
      solanaAddress = addrs['solanaAddress']?.toString();
      if ((address == null || address!.isEmpty) &&
          addrs['evmAddress'] != null) {
        address = addrs['evmAddress']?.toString();
      }
    }
    final list = data['wallets'];
    if (list is List) {
      wallets = list
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
    }
    // Primary may be missing walletId in some payloads — pick from list
    if ((walletId == null || walletId!.isEmpty) && wallets.isNotEmpty) {
      walletId = wallets.first['id']?.toString();
      address ??= wallets.first['address']?.toString();
    }
    if ((address == null || address!.isEmpty) && wallets.isNotEmpty) {
      for (final w in wallets) {
        final a = w['address']?.toString() ?? '';
        if (a.startsWith('0x')) {
          address = a;
          walletId ??= w['id']?.toString();
          break;
        }
      }
    }
    ready = address != null && address!.isNotEmpty && address!.startsWith('0x');
    if (ready) {
      _auth.bindExternalWallet(address!);
      status = 'Wallet ready · ${address!.substring(0, 8)}…';
    }
    notifyListeners();
  }

  List<Map<String, dynamic>> _parseChallenges(dynamic raw) {
    if (raw is! List) return [];
    return raw
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .where((e) => (e['challengeId']?.toString() ?? '').isNotEmpty)
        .toList();
  }

  Future<void> completeOnboarding({bool ensureChains = true}) async {
    if (userToken == null) return;
    busy = true;
    status = 'Loading wallets…';
    notifyListeners();
    try {
      final data = await _api.post('/v1/circle/wallets', body: {
        'userToken': userToken,
        'userId': _userId,
        'ensureChains': ensureChains,
      });
      _applyWalletPayload(data);
      final follow = _parseChallenges(data['followUpChallenges']);
      if (follow.isNotEmpty) {
        // Caller may run these; store for ensureReady
        status = 'Extra chain wallets available';
      }
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<bool> _runChallenges(
    BuildContext context,
    List<Map<String, dynamic>> challenges, {
    required String userToken,
    required String encryptionKey,
    required String appId,
    String title = 'Confirm',
    int depth = 0,
  }) async {
    final ids = challenges
        .map((c) => c['challengeId']?.toString() ?? '')
        .where((id) => id.isNotEmpty)
        .toList();
    // de-dupe, preserve order
    final seen = <String>{};
    final uniqueIds = <String>[];
    for (final id in ids) {
      if (seen.add(id)) uniqueIds.add(id);
    }
    if (uniqueIds.isEmpty) return true;
    if (!context.mounted) return false;
    if (depth > 4) {
      status = 'Too many PIN retries — challenges still pending';
      notifyListeners();
      return false;
    }

    debugPrint(
      'circle _runChallenges: ${uniqueIds.length} id(s) depth=$depth '
      '${uniqueIds.map((e) => e.length > 8 ? '${e.substring(0, 8)}…' : e).join(', ')} '
      'tokenLen=${userToken.length} keyLen=${encryptionKey.trim().length}',
    );

    // ONE WebView for all steps — avoids reopening and feels like a single confirm.
    final raw = await Navigator.of(context).push<Object?>(
      MaterialPageRoute(
        builder: (_) => CircleChallengeScreen(
          appId: appId,
          userToken: userToken,
          encryptionKey: encryptionKey,
          challengeIds: uniqueIds,
          title: title,
        ),
      ),
    );
    if (!context.mounted) return false;

    // Backward compatible: true/false or structured map from challenge screen.
    var webOk = raw == true;
    var cancelled = raw == false;
    List<String> completedFromWeb = [];
    if (raw is Map) {
      final m = Map<String, dynamic>.from(raw);
      webOk = m['ok'] == true;
      cancelled = m['cancelled'] == true;
      final c = m['completedIds'];
      if (c is List) {
        completedFromWeb =
            c.map((e) => e.toString()).where((s) => s.isNotEmpty).toList();
      }
      final sigs = m['signatures'];
      if (sigs is Map) {
        sigs.forEach((k, v) {
          final id = k?.toString() ?? '';
          final sig = v?.toString() ?? '';
          if (id.isNotEmpty && sig.startsWith('0x')) _lastSignatures[id] = sig;
        });
      }
      if (m['partial'] == true) webOk = false;
    }

    if (cancelled && completedFromWeb.isEmpty && !webOk) {
      status = 'Challenge cancelled';
      notifyListeners();
      return false;
    }

    // Always verify on Circle before accepting success (WebView success ≠ COMPLETE).
    status = 'Verifying PIN with Circle…';
    notifyListeners();
    final verified = await verifyChallengesAndHash(
      challengeIds: uniqueIds,
      resolveTxHash: uniqueIds.length == 1,
      timeoutMs: 180000,
    );
    if (verified['ok'] == true) {
      _lastVerifiedTxHash = _circleTxHash(verified);
      status = 'PIN confirmed';
      notifyListeners();
      return true;
    }

    // Re-open WebView only for ids that have NOT settled. A step whose
    // transaction is already on-chain must never be re-prompted — the user
    // would be asked to sign a burn that has already happened.
    final statuses = verified['statuses'];
    final pending = <String>[];
    if (statuses is List) {
      for (final row in statuses) {
        if (row is! Map) continue;
        final id = row['challengeId']?.toString() ?? '';
        final st = row['status']?.toString().toUpperCase() ?? '';
        if (id.isEmpty) continue;
        if (row['dead'] == true || st == 'FAILED' || st == 'EXPIRED') {
          status = 'Challenge ${st.isEmpty ? 'FAILED' : st}';
          notifyListeners();
          return false;
        }
        if (row['settled'] == true) continue;
        if (st != 'COMPLETE' && st != 'COMPLETED' && st != 'SUCCESS') {
          pending.add(id);
        }
      }
    }
    if (pending.isEmpty) {
      // No status breakdown — re-run all that WebView did not claim complete.
      for (final id in uniqueIds) {
        if (!completedFromWeb.contains(id)) pending.add(id);
      }
    }
    if (pending.isEmpty) {
      status = verified['error']?.toString() ?? 'PIN not confirmed';
      notifyListeners();
      return false;
    }

    status = 'Completing ${pending.length} remaining PIN step(s)…';
    notifyListeners();
    if (!context.mounted) return false;
    return _runChallenges(
      context,
      pending.map((id) => {'challengeId': id, 'step': 'retry'}).toList(),
      userToken: userToken,
      encryptionKey: encryptionKey,
      appId: appId,
      title: '$title (remaining)',
      depth: depth + 1,
    );
  }

  /// Challenge page URL with a base64url cfg blob (no +/= corruption).
  /// Supports one or many challenge IDs for sequential PIN execute.
  Uri challengeUri({
    required String userToken,
    required String encryptionKey,
    required String appId,
    String? challengeId,
    List<String>? challengeIds,
  }) {
    final base = Env.resolveApiBaseUrl();
    final ids = <String>[
      if (challengeIds != null) ...challengeIds,
      if (challengeId != null && challengeId.isNotEmpty) challengeId,
    ].where((id) => id.isNotEmpty).toList();
    final payload = jsonEncode({
      'appId': appId,
      'userToken': userToken,
      'encryptionKey': encryptionKey,
      if (ids.isNotEmpty) 'challengeId': ids.first,
      if (ids.isNotEmpty) 'challengeIds': ids,
    });
    final cfg = base64Url.encode(utf8.encode(payload)).replaceAll('=', '');
    return Uri.parse('$base/challenge').replace(queryParameters: {
      'cfg': cfg,
    });
  }

  /// Run any API that returns `{ challenges: [{challengeId}], appId? }`.
  Future<bool> executeChallengeResponse(
    BuildContext context,
    Map<String, dynamic> response, {
    String? title,
  }) async {
    if (userToken == null || encryptionKey == null) {
      // Try soft refresh once before failing (expired tokens).
      await refreshSessionOnly();
    }
    if (userToken == null || encryptionKey == null) {
      throw Exception('Your session ended. Open the app again.');
    }
    final challenges = _parseChallenges(response['challenges']);
    if (challenges.isEmpty) {
      final single = response['challengeId']?.toString();
      if (single != null) {
        challenges.add({'challengeId': single});
      }
    }
    if (challenges.isEmpty) {
      // Also accept challengeIds array from App Kit jobs
      final ids = response['challengeIds'];
      if (ids is List) {
        for (final id in ids) {
          final s = id?.toString() ?? '';
          if (s.isNotEmpty) challenges.add({'challengeId': s});
        }
      }
    }
    if (challenges.isEmpty) {
      status = 'No challenges returned';
      notifyListeners();
      return false;
    }
    final fromResp = response['appId']?.toString().trim();
    if (fromResp != null && fromResp.isNotEmpty) {
      _serverAppId = fromResp;
    }
    final app = appId;
    final t = title ?? 'Confirm with PIN';
    if (!context.mounted) return false;
    return _runChallenges(
      context,
      challenges,
      userToken: userToken!,
      encryptionKey: encryptionKey!,
      appId: app,
      title: t,
    );
  }

  /// Run ONE challenge's PIN screen, then block until Circle's backend
  /// actually reports it COMPLETE (not just "WebView closed with no error").
  /// This makes multi-step flows (approve → burn) truly sequential.
  Future<Map<String, dynamic>> executeChallengeAndVerify(
    BuildContext context,
    String challengeId, {
    String? appId,
    String title = 'Confirm with PIN',
    bool resolveTxHash = false,
    int timeoutMs = 180000,
  }) async {
    final pinOk = await executeChallengeResponse(
      context,
      {
        'challengeId': challengeId,
        'challenges': [
          {'step': 'single', 'challengeId': challengeId},
        ],
        if (appId != null) 'appId': appId,
      },
      title: title,
    );
    if (!pinOk) {
      return {'ok': false, 'error': 'PIN cancelled', 'stage': 'cancelled'};
    }
    if (!context.mounted) {
      return {'ok': false, 'error': 'Cancelled', 'stage': 'unmounted'};
    }
    final verified = await verifyChallengesAndHash(
      challengeIds: [challengeId],
      resolveTxHash: resolveTxHash,
      timeoutMs: timeoutMs,
    );
    final settled = verified['anySettled'] == true;
    final dead = verified['dead'] == true;
    if (verified['ok'] != true) {
      return {
        'ok': false,
        // `settled` means the transaction is already on-chain and only the
        // challenge record is lagging. Callers must continue, not abort —
        // aborting here is what stranded burnt USDC with no mint.
        'settled': settled && !dead,
        'dead': dead,
        'txHash': verified['txHash'],
        'statuses': verified['statuses'],
        'error': verified['error']?.toString() ??
            'PIN closed but Circle has not confirmed this step yet',
        'stage': dead ? 'challenge_failed' : 'verify_pending',
      };
    }
    return {'ok': true, 'settled': true, 'txHash': verified['txHash']};
  }

  /// Relay a typed-data signature captured in the WebView to an App Kit job.
  Future<bool> _relaySignature({
    required String jobId,
    required String challengeId,
  }) async {
    final signature = _lastSignatures[challengeId];
    if (signature == null) return false;
    try {
      final res = await _api.post(
        '/v1/app-kit/jobs/$jobId/signature',
        body: {'challengeId': challengeId, 'signature': signature},
      );
      return res['ok'] == true;
    } catch (e) {
      debugPrint('relaySignature $challengeId: $e');
      return false;
    }
  }

  List<String> _challengeIdsFrom(Map<String, dynamic> response) {
    final list = _parseChallenges(response['challenges'])
        .map((c) => c['challengeId']?.toString() ?? '')
        .where((id) => id.isNotEmpty)
        .toList();
    if (list.isEmpty) {
      final single = response['challengeId']?.toString();
      if (single != null && single.isNotEmpty) list.add(single);
    }
    final ids = response['challengeIds'];
    if (ids is List) {
      for (final id in ids) {
        final s = id?.toString() ?? '';
        if (s.isNotEmpty && !list.contains(s)) list.add(s);
      }
    }
    return list;
  }

  /// After WebView PIN, confirm Circle side COMPLETE and optional tx hash.
  Future<Map<String, dynamic>> verifyChallengesAndHash({
    required List<String> challengeIds,
    bool resolveTxHash = true,
    // Circle's own UCW signing strategy waits 10 minutes for a challenge to
    // settle. A 60s ceiling reported healthy Arc burns as stuck PENDING.
    int timeoutMs = 180000,
  }) async {
    if (userToken == null) await refreshSessionOnly();
    if (userToken == null || challengeIds.isEmpty) {
      return {'ok': false, 'error': 'Your session ended. Open the app again.'};
    }
    try {
      final res = await _api.post(
        '/v1/circle/verify-challenges',
        body: {
          'userToken': userToken,
          'challengeIds': challengeIds,
          'resolveTxHash': resolveTxHash,
          'timeoutMs': timeoutMs,
        },
        timeout: Duration(milliseconds: timeoutMs + 30000),
      );
      return {
        ...res,
        'ok': res['ok'] == true,
        'txHash': res['txHash']?.toString(),
      };
    } catch (e) {
      debugPrint('verifyChallengesAndHash: $e');
      final msg = e.toString();
      if (msg.toLowerCase().contains('usertoken') &&
          msg.toLowerCase().contains('expir')) {
        await refreshSessionOnly();
        return {
          'ok': false,
          'error': 'Session expired — try again',
          'tokenExpired': true,
        };
      }
      return {'ok': false, 'error': msg};
    }
  }

  Future<void> _confirmActivity({
    required String? activityId,
    required bool ok,
    String? txHash,
    bool requireTxHash = false,
  }) async {
    if (activityId == null || activityId.isEmpty) return;
    try {
      await _api.post('/v1/circle/confirm-activity', body: {
        'activityId': activityId,
        'ok': ok,
        if (txHash != null) 'txHash': txHash,
        'userId': _userId,
        if (requireTxHash) 'requireTxHash': true,
      });
    } catch (e) {
      debugPrint('confirm-activity: $e');
    }
  }

  /// Plays the money-out sound for a payment that went through.
  Map<String, dynamic> _outIfOk(Map<String, dynamic> result) {
    if (result['ok'] == true) {
      MoneySounds.instance.playOut(key: result['txHash']?.toString());
    }
    return result;
  }

  /// Send via UCW: direct 0x / known user, or escrow for non-users.
  /// [token] is `USDC` (default) or `EURC` on Arc.
  Future<Map<String, dynamic>> send({
    required BuildContext context,
    required String to,
    required double amountUsdc,
    String token = 'USDC',
    double? amountNgn,
    String? memo,
  }) async =>
      _outIfOk(await _send(
        context: context,
        to: to,
        amountUsdc: amountUsdc,
        token: token,
        amountNgn: amountNgn,
        memo: memo,
      ));

  Future<Map<String, dynamic>> _send({
    required BuildContext context,
    required String to,
    required double amountUsdc,
    String token = 'USDC',
    double? amountNgn,
    String? memo,
  }) async {
    _lastVerifiedTxHash = null;
    final dest = to.trim();
    if (dest.isEmpty) {
      return {'ok': false, 'error': 'Enter a recipient'};
    }
    if (amountUsdc <= 0) {
      return {'ok': false, 'error': 'Enter an amount greater than zero'};
    }

    // Bind API identity from hard-finished Dynamic session.
    _api.setUserId(_userId);
    final jwt = _auth.user?.authToken;
    if (jwt != null && jwt.isNotEmpty && jwt != 'demo-token') {
      _api.setAuthToken(jwt);
    }

    if (!await ensureReady(context)) {
      return {
        'ok': false,
        'error': 'Wallet not ready — set up your PIN in Profile first',
      };
    }
    // Soft refresh Circle session without PIN when possible.
    if (userToken == null || encryptionKey == null) {
      final okSession = await refreshSessionOnly();
      if (!okSession) {
        return {
          'ok': false,
          'error': 'Could not refresh wallet session — try again',
        };
      }
    }

    try {
      final res = await _api.post('/v1/circle/send', body: {
        'userToken': userToken,
        'walletId': walletId,
        'to': dest,
        // Server accepts number; also safe as fixed decimals for amount.
        'amountUsdc': double.parse(amountUsdc.toStringAsFixed(6)),
        'token': token == 'EURC'
            ? 'EURC'
            : (token == 'CIRBTC' || token == 'CBTC' ? 'CIRBTC' : 'USDC'),
        if (amountNgn != null) 'amountNgn': amountNgn,
        if (memo != null) 'memo': memo,
        'userId': _userId,
      });
      if (!context.mounted) return {'ok': false};
      final rail = res['rail']?.toString() ?? '';
      final jobId = res['jobId']?.toString();
      final activityId = res['activityId']?.toString();

      // App Kit UCW: poll job for challenges (may arrive after first response).
      if (rail == 'app-kit-ucw' && jobId != null && jobId.isNotEmpty) {
        final kit = await _completeAppKitSendJob(
          context: context,
          jobId: jobId,
          initial: res,
          title: 'Confirm send',
        );
        final ok = kit['ok'] == true;
        final txHash = _circleTxHash(kit);
        if (txHash != null) _lastVerifiedTxHash = txHash;
        await _confirmActivity(
          activityId: activityId,
          ok: ok,
          txHash: txHash,
          requireTxHash: true,
        );
        status = ok
            ? (res['mode'] == 'escrow'
                ? 'Escrow send approved'
                : 'Send approved')
            : 'Send cancelled — no receipt';
        notifyListeners();
        return {...res, ...kit, if (txHash != null) 'txHash': txHash, 'ok': ok};
      }

      final challenges = _parseChallenges(res['challenges']);
      if (challenges.isEmpty && res['challengeId'] == null) {
        _lastVerifiedTxHash = _circleTxHash(res);
        status = res['mode']?.toString() ?? 'sent';
        notifyListeners();
        return {...res, 'ok': true};
      }
      final ok = await executeChallengeResponse(context, res);
      final txHash = _lastVerifiedTxHash ?? _circleTxHash(res);
      await _confirmActivity(
        activityId: activityId,
        ok: ok,
        txHash: txHash,
        requireTxHash: true,
      );
      if (ok) {
        status =
            res['mode'] == 'escrow' ? 'Escrow send approved' : 'Send approved';
        if (activityId != null && activityId.isNotEmpty) {
          try {
            await _api.patch('/v1/activity/$activityId', body: {
              'status': 'completed',
            });
          } catch (_) {}
        }
      } else {
        status = 'Send cancelled — no receipt';
      }
      notifyListeners();
      return {...res, if (txHash != null) 'txHash': txHash, 'ok': ok};
    } catch (e) {
      debugPrint('circle send: $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// Poll App Kit UCW job and complete any PIN challenges until done.
  /// Uses sequential execute+verify (same as bridge) to avoid PENDING races.
  Future<Map<String, dynamic>> _completeAppKitSendJob({
    required BuildContext context,
    required String jobId,
    required Map<String, dynamic> initial,
    String title = 'Confirm',
  }) async {
    final seen = <String>{};
    // Longer poll while user may still be on PIN (~3 min).
    for (var i = 0; i < 180; i++) {
      if (!context.mounted) {
        return {'ok': false, 'error': 'Cancelled', 'jobId': jobId};
      }
      final latest = i == 0
          ? Map<String, dynamic>.from(initial)
          : await _api.get('/v1/app-kit/jobs/$jobId');
      if (!context.mounted) {
        return {'ok': false, 'error': 'Cancelled', 'jobId': jobId};
      }
      final statusStr = latest['status']?.toString() ?? 'running';
      final challenges = _challengeIdsFrom(latest);
      for (final id in challenges) {
        if (seen.contains(id)) continue;
        seen.add(id);
        status = 'Confirm with your PIN…';
        notifyListeners();
        final result = await executeChallengeAndVerify(
          context,
          id,
          appId: (latest['appId'] ?? initial['appId'])?.toString(),
          title: title,
        );
        if (result['ok'] != true) {
          final cancelled = result['stage'] == 'cancelled';
          return {
            'ok': false,
            'error': cancelled
                ? 'PIN cancelled — no funds moved'
                : (result['error']?.toString() ??
                    'Challenge did not complete on Circle'),
            'jobId': jobId,
          };
        }
      }
      if (statusStr == 'succeeded') {
        return {...latest, 'ok': true, 'jobId': jobId, 'rail': 'app-kit'};
      }
      if (statusStr == 'failed') {
        return {
          'ok': false,
          'error':
              latest['error']?.toString() ?? 'The payment did not go through.',
          'jobId': jobId,
        };
      }
      await Future<void>.delayed(const Duration(milliseconds: 800));
    }
    return {
      'ok': false,
      'error':
          'That is taking longer than usual. Check Activity before trying again.',
      'jobId': jobId,
    };
  }

  // ── Unified balance (App Kit deposit preferred; legacy Gateway fallback) ─

  /// Deposit into unified balance from a supported source chain.
  ///
  /// [chain] App Kit chain name: Arc_Testnet | Ethereum_Sepolia | Base_Sepolia
  Future<bool> gatewayDeposit({
    required BuildContext context,
    required double amountUsdc,
    String chain = 'Arc_Testnet',
  }) async {
    if (!await ensureReady(context)) return false;
    if (userToken == null) await refreshSessionOnly();
    if (!context.mounted) return false;
    // Prefer App Kit unifiedBalance.deposit (never a plain ERC-20 transfer).
    final kit = await appKitDeposit(
      context: context,
      amount: amountUsdc,
      chain: chain,
    );
    if (kit['ok'] == true) {
      status = 'Unified deposit submitted';
      notifyListeners();
      return true;
    }
    // A started job may already have moved the money; a second deposit on
    // the legacy route could take it twice. Home shows the job to continue.
    final startedJob = kit['jobId']?.toString();
    if (startedJob != null && startedJob.isNotEmpty) {
      status = kit['error']?.toString() ?? 'On hold — finish it from Home';
      notifyListeners();
      return false;
    }
    debugPrint('appKit deposit fallback → gateway ($chain): ${kit['error']}');
    final res = await _api.post('/v1/circle/gateway/deposit', body: {
      'userToken': userToken,
      'walletId': walletId,
      'amountUsdc': amountUsdc,
      'chain': chain,
      'userId': _userId,
    });
    if (!context.mounted) return false;
    // Sequential verify so approve+deposit do not race PENDING.
    final ids = _challengeIdsFrom(res);
    final watchId = res['watchId']?.toString();
    if (ids.isEmpty) {
      final ok = await executeChallengeResponse(context, res);
      if (ok) await _confirmTopUp(watchId, null);
      return ok;
    }
    String? txHash;
    for (final id in ids) {
      final step = await executeChallengeAndVerify(
        context,
        id,
        title: 'Confirm top-up',
        resolveTxHash: id == ids.last,
      );
      if (step['ok'] != true) {
        status = step['error']?.toString() ?? 'Deposit PIN failed';
        notifyListeners();
        return false;
      }
      txHash = step['txHash']?.toString() ?? txHash;
    }
    // Signed: the server now shows it as on its way and tells the person when
    // Gateway credits it. Before, the row was written before the PIN.
    await _confirmTopUp(watchId, txHash);
    status = 'Gateway deposit confirmed';
    notifyListeners();
    return true;
  }

  Future<void> _confirmTopUp(String? watchId, String? txHash) async {
    if (watchId == null || watchId.isEmpty) return;
    try {
      await _api.post('/v1/circle/gateway/deposit/confirm', body: {
        'watchId': watchId,
        if (txHash != null && RegExp(r'^0x[a-fA-F0-9]{64}$').hasMatch(txHash))
          'txHash': txHash,
      });
    } catch (e) {
      // The server also notices the money arriving on its own, so a missed
      // confirmation only delays the Activity row.
      debugPrint('confirm top-up: $e');
    }
  }

  /// Pay from **user** Gateway unified USDC balance.
  ///
  /// First pay on a chain may require a one-time PIN to `addDelegate` on each
  /// source chain that will be burned. After that, Circle's ledger spend is
  /// signed by the platform EOA (no dummy PIN).
  Future<Map<String, dynamic>> gatewayPay({
    required BuildContext context,
    required double amountUsdc,
    required int destinationDomain,
    required String destinationAddress,
    int? sourceDomain,
  }) async =>
      _outIfOk(await _gatewayPay(
        context: context,
        amountUsdc: amountUsdc,
        destinationDomain: destinationDomain,
        destinationAddress: destinationAddress,
        sourceDomain: sourceDomain,
      ));

  Future<Map<String, dynamic>> _gatewayPay({
    required BuildContext context,
    required double amountUsdc,
    required int destinationDomain,
    required String destinationAddress,
    int? sourceDomain,
  }) async {
    if (!await ensureReady(context)) {
      return {'ok': false, 'error': 'Wallet not ready'};
    }
    if (userToken == null) await refreshSessionOnly();
    if (userToken == null || walletId == null) {
      return {'ok': false, 'error': 'Your session ended. Open the app again.'};
    }

    try {
      Map<String, dynamic> res = {};
      for (var attempt = 0; attempt < 4; attempt++) {
        if (!context.mounted) return {'ok': false, 'error': 'Cancelled'};
        res = await _api.post('/v1/circle/gateway/pay', body: {
          'userToken': userToken,
          'walletId': walletId,
          'amountUsdc': double.parse(amountUsdc.toStringAsFixed(6)),
          'destinationDomain': destinationDomain,
          'destinationAddress': destinationAddress,
          if (sourceDomain != null) 'sourceDomain': sourceDomain,
          'userId': _userId,
        });
        if (!context.mounted) return {'ok': false, 'error': 'Cancelled'};

        final mode = res['mode']?.toString();
        final ids = _challengeIdsFrom(res);
        final needsDelegate =
            mode == 'delegate_setup' || res['needsDelegate'] == true;

        if (needsDelegate && ids.isNotEmpty) {
          status = 'One-time approval on each network…';
          notifyListeners();
          for (final id in ids) {
            final step = await executeChallengeAndVerify(
              context,
              id,
              title: 'Approve this once',
              resolveTxHash: true,
            );
            if (step['ok'] != true && step['settled'] != true) {
              return {
                ...res,
                'ok': false,
                'error': step['error']?.toString() ??
                    'Delegate authorization cancelled',
              };
            }
          }
          await Future<void>.delayed(const Duration(seconds: 8));
          if (userToken == null) await refreshSessionOnly();
          continue;
        }

        if (res['doNotRetry'] == true && !needsDelegate) {
          break;
        }

        if (ids.isNotEmpty && !needsDelegate) {
          final ok = await executeChallengeResponse(context, res);
          return {...res, 'ok': ok};
        }
        break;
      }

      final err = res['error']?.toString();
      final mintTx = res['mintTx']?.toString();
      final transferId = res['transferId']?.toString();
      final payStatus = res['status']?.toString();
      final mintLooksReal = mintTx != null &&
          mintTx.isNotEmpty &&
          (mintTx.startsWith('0x') || mintTx.length >= 32);
      final paid = res['ok'] == true &&
          (mintLooksReal ||
              payStatus == 'complete' ||
              (transferId != null &&
                  transferId.isNotEmpty &&
                  payStatus == 'forwarded'));
      if (paid) {
        status = 'Gateway pay complete';
        notifyListeners();
        return {...res, 'ok': true, 'mintTx': mintTx};
      }
      if (res['doNotRetry'] == true) {
        status = err ?? 'Pay in transit — do not retry';
        notifyListeners();
        return {
          ...res,
          'ok': false,
          'doNotRetry': true,
          'error': err ??
              'Pay submitted. Destination mint is in transit — do not retry.',
        };
      }
      status = err ?? 'Pay did not mint on destination';
      notifyListeners();
      return {
        ...res,
        'ok': false,
        'error': err ??
            'Pay did not confirm a destination mint — funds were not sent',
      };
    } catch (e) {
      debugPrint('circle gatewayPay: $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// CCTP burn via UCW only (no destination mint). Prefer [bridge] for e2e.
  Future<bool> cctpBurn({
    required BuildContext context,
    required double amountUsdc,
    required int destinationDomain,
    required String mintRecipient,
  }) async {
    final res = await bridge(
      context: context,
      amountUsdc: amountUsdc,
      destinationDomain: destinationDomain,
      mintRecipient: mintRecipient,
      burnOnly: true,
    );
    return res['ok'] == true || res['stage'] == 'burned';
  }

  String get _pendingJobsPrefKey => 'evabob_pending_appkit_jobs_$_userId';

  Future<void> refreshOpenJobs() async {
    try {
      Map<String, dynamic> data;
      try {
        data = await _api.post(
          '/v1/app-kit/jobs/reconcile',
          body: {
            if (userToken != null) 'userToken': userToken,
          },
        );
      } catch (e) {
        debugPrint('reconcile open jobs: $e');
        data = await _api.get(
          '/v1/app-kit/jobs',
          query: {'status': 'running'},
        );
      }
      final list = data['jobs'] as List? ?? [];
      openJobs = list
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .where((e) => e['abandoned'] != true)
          .toList();
      final dismissed = data['dismissed'] as List? ?? [];
      for (final raw in dismissed) {
        if (raw is! Map) continue;
        final row = Map<String, dynamic>.from(raw);
        final id = row['jobId']?.toString();
        if (id != null && id.isNotEmpty) {
          await _forgetJob(id, notify: false);
        }
        if (row['fundsIntact'] == true) {
          _noteFundsIntact(
            row['message']?.toString() ??
                'Bridge PIN expired. Your funds were not moved.',
          );
        }
      }
      notifyListeners();
    } catch (e) {
      debugPrint('refreshOpenJobs: $e');
    }
  }

  Future<void> _rememberJob(String jobId, {String? op, String? label}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_pendingJobsPrefKey);
      final list = <Map<String, dynamic>>[];
      if (raw != null && raw.isNotEmpty) {
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          for (final e in decoded.whereType<Map>()) {
            list.add(Map<String, dynamic>.from(e));
          }
        }
      }
      list.removeWhere((e) => e['jobId']?.toString() == jobId);
      list.insert(0, {
        'jobId': jobId,
        'op': op,
        'label': label,
        'at': DateTime.now().toIso8601String(),
      });
      await prefs.setString(
          _pendingJobsPrefKey, jsonEncode(list.take(20).toList()));
    } catch (e) {
      debugPrint('rememberJob: $e');
    }
    await refreshOpenJobs();
  }

  Future<void> _forgetJob(String jobId, {bool notify = true}) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_pendingJobsPrefKey);
      if (raw == null || raw.isEmpty) {
        // still drop from memory below
      } else {
        final decoded = jsonDecode(raw);
        if (decoded is List) {
          final list = decoded
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .where((e) => e['jobId']?.toString() != jobId)
              .toList();
          await prefs.setString(_pendingJobsPrefKey, jsonEncode(list));
        }
      }
    } catch (e) {
      debugPrint('forgetJob: $e');
    }
    openJobs = openJobs.where((e) => e['jobId']?.toString() != jobId).toList();
    if (notify) notifyListeners();
  }

  /// Continue a bridge/swap after the app was closed mid-PIN.
  Future<Map<String, dynamic>> resumeAppKitJob({
    required BuildContext context,
    required String jobId,
  }) async {
    if (!await ensureReady(context)) {
      return {'ok': false, 'error': 'Wallet not ready'};
    }
    await refreshSessionOnly();
    try {
      var latest = await _api.get('/v1/app-kit/jobs/$jobId');
      if (latest['status']?.toString() == 'succeeded') {
        await _forgetJob(jobId);
        return {...latest, 'ok': true, 'jobId': jobId, 'rail': 'app-kit'};
      }
      if (latest['fundsIntact'] == true || latest['abandoned'] == true) {
        await _forgetJob(jobId);
        final msg = latest['message']?.toString() ??
            latest['error']?.toString() ??
            'PIN expired — your funds were not moved';
        return {
          ...latest,
          'ok': false,
          'fundsIntact': true,
          'error': msg,
          'jobId': jobId,
        };
      }
      if (latest['live'] != true && latest['status']?.toString() == 'running') {
        try {
          latest = await _api.post(
            '/v1/app-kit/jobs/$jobId/recover',
            body: {
              if (userToken != null) 'userToken': userToken,
            },
          );
          if (latest['fundsIntact'] == true || latest['abandoned'] == true) {
            await _forgetJob(jobId);
            final msg = latest['message']?.toString() ??
                latest['error']?.toString() ??
                'PIN expired — your funds were not moved';
            return {
              ...latest,
              'ok': false,
              'fundsIntact': true,
              'error': msg,
              'jobId': jobId,
            };
          }
          if (latest['ok'] == true &&
              latest['status']?.toString() == 'succeeded') {
            await _forgetJob(jobId);
            return {...latest, 'ok': true, 'jobId': jobId, 'rail': 'app-kit'};
          }
        } catch (e) {
          debugPrint('recover job: $e');
        }
      }
      if (!context.mounted) {
        return {
          'ok': false,
          'error': 'You left before confirming. Open Activity to finish it.',
          'jobId': jobId,
          'stage': 'paused',
        };
      }
      final op = latest['op']?.toString() ?? 'transfer';
      return _pollAppKitJob(
        context: context,
        jobId: jobId,
        title: 'Continue $op',
        appIdHint: latest['appId']?.toString(),
      );
    } catch (e) {
      return {'ok': false, 'error': e.toString(), 'jobId': jobId};
    }
  }

  Future<Map<String, dynamic>?> _reconcileExpiredJob(String jobId) async {
    try {
      final rec = await _api.post(
        '/v1/app-kit/jobs/reconcile',
        body: {
          if (userToken != null) 'userToken': userToken,
          'jobId': jobId,
        },
      );
      final dismissed = rec['dismissed'] as List? ?? [];
      for (final raw in dismissed) {
        if (raw is! Map) continue;
        final row = Map<String, dynamic>.from(raw);
        if (row['jobId']?.toString() != jobId) continue;
        if (row['fundsIntact'] == true) {
          await _forgetJob(jobId);
          final msg = row['message']?.toString() ??
              'PIN expired — your funds were not moved';
          return {
            'ok': false,
            'fundsIntact': true,
            'error': msg,
            'jobId': jobId,
            'stage': 'expired',
          };
        }
      }
    } catch (e) {
      debugPrint('reconcileExpiredJob: $e');
    }
    return null;
  }

  /// Poll an existing App Kit job and complete remaining PIN challenges.
  Future<Map<String, dynamic>> _pollAppKitJob({
    required BuildContext context,
    required String jobId,
    String title = 'Confirm with PIN',
    String? appIdHint,
  }) async {
    final seen = <String>{};
    Map<String, dynamic> latest = {};
    for (var i = 0; i < 180; i++) {
      if (!context.mounted) {
        return {
          'ok': false,
          'error': 'Left the app — open Activity to Continue this transfer',
          'jobId': jobId,
          'stage': 'paused',
        };
      }
      latest = await _api.get('/v1/app-kit/jobs/$jobId');
      final statusStr = latest['status']?.toString() ?? 'running';
      final jobStage = latest['stage']?.toString();
      // The PIN worker has stopped but money is moving (or the server is
      // finishing the mint). There is nothing left to sign here — waiting in
      // this loop would only look frozen. Hand back to Home.
      if (statusStr == 'running' &&
          latest['live'] != true &&
          (jobStage == 'sent' || jobStage == 'confirming')) {
        await refreshOpenJobs();
        return {
          'ok': false,
          'error': latest['message']?.toString() ??
              'Your money is on its way. Finish it from Home.',
          'jobId': jobId,
          'stage': jobStage,
        };
      }
      if (latest['fundsIntact'] == true || latest['abandoned'] == true) {
        final dropped = await _reconcileExpiredJob(jobId);
        return dropped ??
            {
              'ok': false,
              'fundsIntact': true,
              'error': latest['message']?.toString() ??
                  'PIN expired — your funds were not moved',
              'jobId': jobId,
              'stage': 'expired',
            };
      }
      final challenges = _challengeIdsFrom(latest);
      for (final id in challenges) {
        if (seen.contains(id)) continue;
        seen.add(id);
        final pre = await verifyChallengesAndHash(
          challengeIds: [id],
          resolveTxHash: false,
          timeoutMs: 2500,
        );
        if (pre['ok'] == true || pre['anySettled'] == true) {
          await _relaySignature(jobId: jobId, challengeId: id);
          continue;
        }
        if (pre['dead'] == true) {
          final dropped = await _reconcileExpiredJob(jobId);
          if (dropped != null) return dropped;
          // Challenge expired but funds may have moved — mint, don't re-PIN.
          try {
            final recovered = await _api.post(
              '/v1/app-kit/jobs/$jobId/recover',
              body: {
                if (userToken != null) 'userToken': userToken,
              },
            );
            if (recovered['fundsIntact'] == true ||
                recovered['abandoned'] == true) {
              await _forgetJob(jobId);
              return {
                'ok': false,
                'fundsIntact': true,
                'error': recovered['message']?.toString() ??
                    recovered['error']?.toString() ??
                    'PIN expired — your funds were not moved',
                'jobId': jobId,
                'stage': 'expired',
              };
            }
            if (recovered['ok'] == true &&
                recovered['status']?.toString() == 'succeeded') {
              await _forgetJob(jobId);
              return {
                ...recovered,
                'ok': true,
                'jobId': jobId,
                'rail': 'app-kit',
              };
            }
          } catch (e) {
            debugPrint('recover after expired challenge: $e');
          }
        }
        if (!context.mounted) {
          return {
            'ok': false,
            'error': 'Left the app — open Activity to Continue this transfer',
            'jobId': jobId,
            'stage': 'paused',
          };
        }
        status = 'Confirm with your PIN…';
        notifyListeners();
        final result = await executeChallengeAndVerify(
          context,
          id,
          appId: (latest['appId'] ?? appIdHint)?.toString(),
          title: title,
        );
        await _relaySignature(jobId: jobId, challengeId: id);

        if (result['stage'] == 'unmounted' || result['stage'] == 'paused') {
          return {
            'ok': false,
            'error': 'Left the app — open Activity to Continue this transfer',
            'jobId': jobId,
            'stage': 'paused',
          };
        }

        final proceed = result['ok'] == true || result['settled'] == true;
        if (!proceed) {
          final cancelled = result['stage'] == 'cancelled';
          final dead = result['dead'] == true;
          if (dead) {
            final dropped = await _reconcileExpiredJob(jobId);
            if (dropped != null) return dropped;
          }
          return {
            'ok': false,
            'error': cancelled
                ? 'PIN cancelled — check Activity to Continue'
                : (result['error']?.toString() ??
                    'Challenge did not complete on Circle'),
            'jobId': jobId,
            'stage': result['stage'] ?? 'paused',
          };
        }
      }

      final awaiting = latest['awaitingSignature'];
      if (awaiting is List) {
        for (final e in awaiting) {
          final id = e?.toString() ?? '';
          if (id.isNotEmpty) {
            await _relaySignature(jobId: jobId, challengeId: id);
          }
        }
      }
      if (statusStr == 'succeeded') {
        status = 'Done';
        notifyListeners();
        await _forgetJob(jobId);
        return {...latest, 'ok': true, 'jobId': jobId, 'rail': 'app-kit'};
      }
      if (statusStr == 'failed') {
        if (latest['fundsIntact'] == true || latest['abandoned'] == true) {
          final dropped = await _reconcileExpiredJob(jobId);
          if (dropped != null) return dropped;
        }
        final err = latest['error']?.toString() ?? 'That did not go through.';
        status = err;
        notifyListeners();
        await _forgetJob(jobId);
        return {'ok': false, 'error': err, 'jobId': jobId};
      }
      await Future<void>.delayed(const Duration(milliseconds: 800));
    }
    return {
      'ok': false,
      'error': 'Still waiting — open Activity to Continue',
      'jobId': jobId,
      'stage': 'paused',
    };
  }

  /// Circle App Kit UCW job: poll until challenges appear / job finishes.
  Future<Map<String, dynamic>> _runAppKitJob({
    required BuildContext context,
    required String startPath,
    required Map<String, dynamic> body,
    String title = 'Confirm with PIN',
  }) async {
    if (!await ensureReady(context)) {
      return {'ok': false, 'error': 'Wallet not ready'};
    }
    await refreshSessionOnly();
    if (userToken == null) {
      return {'ok': false, 'error': 'Your session ended. Open the app again.'};
    }
    try {
      status = 'Starting…';
      notifyListeners();
      final start = await _api.post(startPath, body: {
        ...body,
        'userToken': userToken,
        'walletId': walletId,
        if (address != null) 'walletAddress': address,
        'userId': _userId,
      });
      final jobId = start['jobId']?.toString();
      if (jobId == null || jobId.isEmpty) {
        return {
          ...start,
          'ok': false,
          'error':
              start['error']?.toString() ?? 'Could not start that. Try again.',
        };
      }
      await _rememberJob(
        jobId,
        op: start['op']?.toString(),
        label: title,
      );
      if (!context.mounted) {
        return {
          'ok': false,
          'error': 'Left the app — open Activity to Continue this transfer',
          'jobId': jobId,
          'stage': 'paused',
        };
      }
      return _pollAppKitJob(
        context: context,
        jobId: jobId,
        title: title,
        appIdHint: start['appId']?.toString(),
      );
    } catch (e) {
      debugPrint('appKit job: $e');
      return {
        'ok': false,
        'error':
            e.toString().replaceFirst(RegExp(r'^ApiException\(\d+\):\s*'), ''),
      };
    }
  }

  /// App Kit swap (USDC ↔ EURC on Arc) — preferred over Synthra when available.
  Future<Map<String, dynamic>> appKitSwap({
    required BuildContext context,
    required String tokenIn,
    required String tokenOut,
    required double amountIn,
    String chain = 'Arc_Testnet',
  }) {
    return _runAppKitJob(
      context: context,
      startPath: '/v1/app-kit/ucw/swap',
      title: 'Confirm swap',
      body: {
        'amountIn': amountIn,
        'tokenIn': tokenIn,
        'tokenOut': tokenOut,
        'chain': chain,
      },
    );
  }

  /// App Kit bridge (CCTP under the hood).
  Future<Map<String, dynamic>> appKitBridge({
    required BuildContext context,
    required double amount,
    required String toChain,
    String fromChain = 'Arc_Testnet',
    String? toAddress,
    String token = 'USDC',
  }) {
    return _runAppKitJob(
      context: context,
      startPath: '/v1/app-kit/ucw/bridge',
      title: 'Confirm bridge',
      body: {
        'amount': amount,
        'fromChain': fromChain,
        'toChain': toChain,
        // CCTP is USDC-only. Never send EURC/cirBTC — App Kit rejects it.
        'token': 'USDC',
        if (toAddress != null) 'toAddress': toAddress,
      },
    );
  }

  /// App Kit unified balance deposit.
  Future<Map<String, dynamic>> appKitDeposit({
    required BuildContext context,
    required double amount,
    String chain = 'Arc_Testnet',
  }) {
    return _runAppKitJob(
      context: context,
      startPath: '/v1/app-kit/ucw/deposit',
      title: 'Confirm deposit',
      body: {'amount': amount, 'chain': chain},
    );
  }

  /// App Kit multi-step compose (spend → swap → bridge).
  Future<Map<String, dynamic>> appKitCompose({
    required BuildContext context,
    Map<String, dynamic>? spend,
    Map<String, dynamic>? swap,
    Map<String, dynamic>? bridge,
  }) {
    return _runAppKitJob(
      context: context,
      startPath: '/v1/app-kit/ucw/compose',
      title: 'Confirm composed transfer',
      body: {
        if (spend != null) 'spend': spend,
        if (swap != null) 'swap': swap,
        if (bridge != null) 'bridge': bridge,
      },
    );
  }

  /// On-chain buy/swap via App Kit first, Synthra fallback (USDC ↔ EURC).
  Future<Map<String, dynamic>> swap({
    required BuildContext context,
    required String from,
    required String to,
    required double amountIn,
    int slippageBps = 50,
    int? fromDecimals,
    int? toDecimals,
    bool preferAppKit = true,
  }) async {
    if (preferAppKit &&
        !RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(from) &&
        !RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(to)) {
      final kit = await appKitSwap(
        context: context,
        tokenIn: from.toUpperCase(),
        tokenOut: to.toUpperCase(),
        amountIn: amountIn,
      );
      if (kit['ok'] == true) return kit;
      // Fall through to Synthra if App Kit unavailable
      debugPrint('appKit swap fallback → synthra: ${kit['error']}');
    }
    if (!context.mounted) {
      return {'ok': false, 'error': 'Cancelled'};
    }
    if (from.toLowerCase() == to.toLowerCase()) {
      return {'ok': false, 'error': 'Spend and receive tokens must differ'};
    }
    if (!await ensureReady(context)) {
      return {'ok': false, 'error': 'Wallet not ready'};
    }
    // Always refresh Circle session — tokens expire and break PIN / txs.
    await refreshSessionOnly();
    final decimals = fromDecimals ??
        (from.toUpperCase() == 'CIRBTC'
            ? 8
            : RegExp(r'^0x[a-fA-F0-9]{40}$').hasMatch(from)
                ? 18
                : 6);
    try {
      status = 'Building swap…';
      notifyListeners();
      final res = await _api.post('/v1/circle/swap', body: {
        'userToken': userToken,
        'walletId': walletId,
        'from': from,
        'to': to,
        'amountIn': double.parse(amountIn.toStringAsFixed(decimals)),
        'recipient': address,
        'slippageBps': slippageBps,
        if (fromDecimals != null) 'fromDecimals': fromDecimals,
        if (toDecimals != null) 'toDecimals': toDecimals,
        'userId': _userId,
      });
      if (!context.mounted) return {'ok': false, 'error': 'Cancelled'};
      final challengeIds = _challengeIdsFrom(res);
      if (challengeIds.isEmpty) {
        final err = res['error']?.toString() ??
            res['hint']?.toString() ??
            'No swap challenges returned';
        status = err;
        notifyListeners();
        return {...res, 'ok': false, 'error': err};
      }
      status = challengeIds.length > 1
          ? 'Confirm approve + swap PIN…'
          : 'Confirm swap PIN…';
      notifyListeners();
      final pinOk = await executeChallengeResponse(
        context,
        res,
        title: 'Confirm swap',
      );
      final activityId = res['activityId']?.toString();
      if (!pinOk) {
        await _confirmActivity(activityId: activityId, ok: false);
        status = 'Swap cancelled — no funds moved';
        notifyListeners();
        return {
          ...res,
          'ok': false,
          'error': 'PIN cancelled — no funds moved',
        };
      }

      // Verify Circle challenge COMPLETE + real tx hash before receipt.
      status = 'Confirming on-chain swap…';
      notifyListeners();
      final verified = await verifyChallengesAndHash(
        challengeIds: challengeIds,
        resolveTxHash: true,
      );
      if (verified['ok'] != true) {
        await _confirmActivity(activityId: activityId, ok: false);
        final err = verified['error']?.toString() ??
            'Swap PIN UI finished but on-chain step did not complete';
        status = err;
        notifyListeners();
        return {'ok': false, 'error': err, 'stage': 'verify'};
      }

      final txHash = verified['txHash']?.toString();
      if (txHash == null || !txHash.startsWith('0x')) {
        // Challenges COMPLETE but hash lag — still better than fake ucw: receipt
        await _confirmActivity(
          activityId: activityId,
          ok: true,
          txHash: txHash,
          requireTxHash: true,
        );
        status = 'Swap submitted — waiting for explorer hash';
        notifyListeners();
        return {
          ...res,
          'ok': false,
          'error':
              'Swap challenges completed but tx hash not ready yet. Check wallet balance shortly; no fake receipt created.',
          'pendingOnchain': true,
        };
      }

      await _confirmActivity(
        activityId: activityId,
        ok: true,
        txHash: txHash,
      );
      status = 'Swap confirmed on-chain';
      notifyListeners();
      return {
        ...res,
        'ok': true,
        'txHash': txHash,
      };
    } catch (e) {
      debugPrint('circle swap: $e');
      status = 'Swap failed';
      notifyListeners();
      final msg =
          e.toString().replaceFirst(RegExp(r'^ApiException\(\d+\):\s*'), '');
      if (msg.toLowerCase().contains('usertoken') &&
          msg.toLowerCase().contains('expir')) {
        await refreshSessionOnly();
        return {
          'ok': false,
          'error': 'Your session ended. Start again from Move money.',
        };
      }
      return {'ok': false, 'error': msg};
    }
  }

  /// Map CCTP domain → App Kit chain (product-supported only).
  static String? appKitChainForDomain(int domain) {
    switch (domain) {
      case 26:
        return 'Arc_Testnet';
      case 0:
        return 'Ethereum_Sepolia';
      case 6:
        return 'Base_Sepolia';
      default:
        return null;
    }
  }

  /// End-to-end bridge: prefer App Kit UCW (Forwarder mint); legacy CCTP fallback.
  ///
  /// [sourceDomain] CCTP domain of the burn chain (26 Arc, 6 Base, 0 Eth).
  /// [onStage] reports UI progress: `pin`, `resolving`, `attesting`, `minted`, etc.
  /// Set [burnOnly] true to skip destination mint (legacy path only).
  Future<Map<String, dynamic>> bridge({
    required BuildContext context,
    required double amountUsdc,
    required int destinationDomain,
    required String mintRecipient,
    int sourceDomain = 26,
    bool burnOnly = false,
    String token = 'USDC',
    void Function(String stage, String label)? onStage,
  }) async {
    void stage(String s, String label) {
      status = label;
      notifyListeners();
      onStage?.call(s, label);
    }

    if (sourceDomain == destinationDomain) {
      return {
        'ok': false,
        'error': 'Source and destination must differ',
        'stage': 'validation',
      };
    }

    if (!await ensureReady(context)) {
      return {'ok': false, 'error': 'Wallet not ready', 'stage': 'wallet'};
    }
    await refreshSessionOnly();
    if (!context.mounted) {
      return {'ok': false, 'error': 'Cancelled', 'stage': 'cancelled'};
    }
    if (userToken == null || encryptionKey == null) {
      return {
        'ok': false,
        'error':
            'Could not refresh wallet session — try Profile → wallet setup',
        'stage': 'session',
      };
    }

    // App Kit path (product chains only) — supports bidirectional routes.
    final fromChain = appKitChainForDomain(sourceDomain) ?? 'Arc_Testnet';
    final toChain = appKitChainForDomain(destinationDomain);
    if (!burnOnly && toChain != null) {
      stage('pin', 'Confirm bridge with PIN…');
      final kit = await appKitBridge(
        context: context,
        amount: amountUsdc,
        toChain: toChain,
        fromChain: fromChain,
        toAddress: mintRecipient,
        token: token,
      );
      if (kit['ok'] == true) {
        stage('minted', 'Arrived');
        return {
          ...kit,
          'ok': true,
          'stage': 'minted',
          'rail': 'app-kit',
          'fromChain': fromChain,
          'toChain': toChain,
        };
      }
      // Once an App Kit job exists, a PIN may already have burned the money.
      // Starting the legacy bridge now could send it a second time. The job
      // stays on Home, where Continue finishes it.
      final startedJob = kit['jobId']?.toString();
      if (startedJob != null && startedJob.isNotEmpty) {
        stage(kit['stage']?.toString() ?? 'paused',
            'On hold — finish it from Home');
        return {
          ...kit,
          'ok': false,
          'stage': kit['stage'] ?? 'paused',
          'rail': 'app-kit',
          'fromChain': fromChain,
          'toChain': toChain,
        };
      }
      debugPrint('appKit bridge fallback → legacy CCTP: ${kit['error']}');
      // Legacy CCTP burn contracts on this app are Arc-only USDC.
      if (sourceDomain != 26 || token.toUpperCase() != 'USDC') {
        return {
          'ok': false,
          'error': kit['error']?.toString() ??
              'Bridge $token $fromChain → $toChain failed',
          'stage': 'error',
          'fromChain': fromChain,
          'toChain': toChain,
        };
      }
      stage('pin', 'Retrying bridge…');
    }

    stage('pin', 'Confirm bridge with PIN…');
    Map<String, dynamic> burnRes;
    try {
      burnRes = await _api.post('/v1/circle/cctp/burn', body: {
        'userToken': userToken,
        'walletId': walletId,
        'amountUsdc': amountUsdc,
        'destinationDomain': destinationDomain,
        'mintRecipient': mintRecipient,
        'userId': _userId,
      });
    } catch (e) {
      debugPrint('circle cctp burn: $e');
      final msg =
          e.toString().replaceFirst(RegExp(r'^ApiException\(\d+\):\s*'), '');
      if (msg.toLowerCase().contains('usertoken') ||
          msg.toLowerCase().contains('expired')) {
        await refreshSessionOnly();
        return {
          'ok': false,
          'error': 'Your session ended. Start again from Move money.',
          'stage': 'session',
        };
      }
      return {'ok': false, 'error': msg, 'stage': 'burn_request'};
    }
    if (!context.mounted) {
      return {'ok': false, 'error': 'Cancelled', 'stage': 'unmounted'};
    }

    final challenges = _parseChallenges(burnRes['challenges']);
    final challengeIds = _challengeIdsFrom(burnRes);
    if (challengeIds.isEmpty) {
      return {
        ...burnRes,
        'ok': false,
        'error': burnRes['error']?.toString() ?? 'No burn challenges returned',
        'stage': 'burn_request',
      };
    }

    final activityId = burnRes['activityId']?.toString();

    // Prefer explicit burnChallengeId; fall back to depositForBurn step.
    String? burnChallengeId = burnRes['burnChallengeId']?.toString();
    if (burnChallengeId == null || burnChallengeId.isEmpty) {
      for (final ch in challenges) {
        if (ch['step']?.toString() == 'depositForBurn') {
          burnChallengeId = ch['challengeId']?.toString();
          break;
        }
      }
      if ((burnChallengeId == null || burnChallengeId.isEmpty) &&
          challengeIds.isNotEmpty) {
        burnChallengeId = challengeIds.last;
      }
    }

    // Sequential: approve COMPLETE → create burn challenge → burn COMPLETE.
    // Avoids PENDING race when both challenges were created up front.
    String? knownBurnHash;
    final sequential = burnRes['sequential'] == true ||
        burnRes['step']?.toString() == 'approve' ||
        (challenges.length == 1 &&
            challenges.first['step']?.toString() == 'approve');
    final intentId = burnRes['intentId']?.toString() ?? activityId;

    Future<Map<String, dynamic>> runStep(
      Map<String, dynamic> ch, {
      required bool resolveTx,
    }) async {
      final id = ch['challengeId']?.toString();
      if (id == null || id.isEmpty) {
        return {'ok': false, 'error': 'Could not start that. Try again.'};
      }
      final step = ch['step']?.toString() ?? 'burn';
      final label = step == 'approve' ? 'Approving…' : 'Confirm burn on Arc…';
      stage('pin', label);
      final result = await executeChallengeAndVerify(
        context,
        id,
        title: 'Confirm bridge — $label',
        resolveTxHash: resolveTx,
        // The burn needs the longest window: PIN → Circle finalize → Arc block.
        timeoutMs: resolveTx ? 240000 : 120000,
      );
      if (result['ok'] == true) {
        stage('resolving', '$label ✓');
        return result;
      }

      final cancelled = result['stage'] == 'cancelled';
      final dead = result['dead'] == true;
      final settled = result['settled'] == true;

      // The challenge record lags the chain. If Circle already has a
      // transaction for this step, the step happened — carry on and let
      // /cctp/finish resolve the hash. Only a real cancel, or a FAILED /
      // EXPIRED challenge, means nothing moved.
      if (settled && !cancelled && !dead) {
        stage('resolving', '$label ✓ (confirming on Arc…)');
        return {...result, 'ok': true, 'unconfirmed': true};
      }

      final err = result['error']?.toString() ?? 'Step "$step" failed';
      stage(cancelled ? 'cancelled' : 'error', err);
      // Only discard the activity when we are sure no funds moved. Discarding
      // on an inconclusive burn is what lost the receipt for burnt USDC.
      if (cancelled || dead || step == 'approve') {
        await _confirmActivity(activityId: activityId, ok: false);
      }
      return {
        ...result,
        'ok': false,
        'error': err,
        'stage': cancelled
            ? 'cancelled'
            : dead
                ? 'challenge_failed'
                : 'resolve_burn',
        'failedStep': step,
        'activityId': activityId,
      };
    }

    if (sequential) {
      // 1) Approve
      final approveCh = challenges.firstWhere(
        (c) => c['step']?.toString() == 'approve',
        orElse: () => challenges.isNotEmpty ? challenges.first : {},
      );
      final approveResult = await runStep(approveCh, resolveTx: false);
      if (approveResult['ok'] != true) return approveResult;
      if (!context.mounted) {
        return {'ok': false, 'error': 'Cancelled', 'stage': 'unmounted'};
      }

      // 2) Create burn challenge only after approve COMPLETE
      stage('pin', 'Preparing burn…');
      Map<String, dynamic> burnStepRes;
      try {
        burnStepRes = await _api.post('/v1/circle/cctp/burn/continue', body: {
          'userToken': userToken,
          'walletId': walletId,
          'intentId': intentId,
          if (activityId != null) 'activityId': activityId,
          'amountUsdc': amountUsdc,
          'destinationDomain': destinationDomain,
          'mintRecipient': mintRecipient,
          'userId': _userId,
        });
      } catch (e) {
        await _confirmActivity(activityId: activityId, ok: false);
        return {
          'ok': false,
          'error': e.toString(),
          'stage': 'burn_continue',
          'activityId': activityId,
        };
      }
      final burnChallenges = _parseChallenges(burnStepRes['challenges']);
      burnChallengeId = burnStepRes['burnChallengeId']?.toString() ??
          (burnChallenges.isNotEmpty
              ? burnChallenges.first['challengeId']?.toString()
              : null);
      if (burnChallengeId == null || burnChallengeId.isEmpty) {
        await _confirmActivity(activityId: activityId, ok: false);
        return {
          'ok': false,
          'error': burnStepRes['error']?.toString() ??
              'No burn challenge after approve',
          'stage': 'burn_continue',
          'activityId': activityId,
        };
      }
      final burnResult = await runStep(
        {
          'step': 'depositForBurn',
          'challengeId': burnChallengeId,
        },
        resolveTx: true,
      );
      // A burn that we cannot confirm is NOT a burn that did not happen.
      // Unless the user cancelled or Circle failed the challenge, fall through
      // to /cctp/finish — it re-resolves the hash from burnChallengeId and
      // then drives attestation + mint. Returning here was the reason
      // attestation never started after a successful PIN burn.
      if (burnResult['ok'] != true &&
          (burnResult['stage'] == 'cancelled' ||
              burnResult['stage'] == 'challenge_failed')) {
        return burnResult;
      }
      knownBurnHash = burnResult['txHash']?.toString();
    } else {
      // Legacy path: both challenges already present
      for (final ch in challenges) {
        final id = ch['challengeId']?.toString();
        if (id == null || id.isEmpty) continue;
        final result = await runStep(
          ch,
          resolveTx: id == burnChallengeId,
        );
        final isBurn = id == burnChallengeId;
        if (result['ok'] != true) {
          // Same rule as the sequential path: only a cancel or a dead
          // challenge stops the pipeline once the burn has been attempted.
          if (!isBurn ||
              result['stage'] == 'cancelled' ||
              result['stage'] == 'challenge_failed') {
            return result;
          }
        }
        if (isBurn) {
          knownBurnHash = result['txHash']?.toString();
        }
      }
    }

    stage(
      burnOnly ? 'resolving' : 'attesting',
      burnOnly
          ? 'Confirming burn on Arc…'
          : 'Burn confirmed · waiting for Circle fast attestation & mint…',
    );

    try {
      // Re-refresh token before long finish call (resolve + Iris can take >1 min).
      await refreshSessionOnly();
      final finish = await _api.post(
        '/v1/circle/cctp/finish',
        body: {
          'userToken': userToken,
          if (knownBurnHash != null && knownBurnHash.startsWith('0x'))
            'burnTxHash': knownBurnHash
          else if (burnChallengeId != null)
            'burnChallengeId': burnChallengeId,
          'destinationDomain': destinationDomain,
          'sourceDomain': burnRes['sourceDomain'] ?? 26,
          if (activityId != null) 'activityId': activityId,
          'userId': _userId,
          'burnOnly': burnOnly,
          'timeoutMs': 180000,
        },
        // Must exceed the server's burn-hash resolve window (180s) or the
        // client aborts a finish that was about to succeed.
        timeout: const Duration(seconds: 240),
      );

      final ok = finish['ok'] == true;
      final stageName =
          finish['stage']?.toString() ?? (ok ? 'minted' : 'error');
      if (ok && stageName == 'minted') {
        stage('minted', 'Bridge complete · minted on destination');
      } else if (ok && stageName == 'burned') {
        stage('burned', 'Burn complete on Arc');
      } else if (stageName == 'attesting') {
        stage(
          'attesting',
          finish['error']?.toString() ??
              'Burned — attestation still pending, retry later',
        );
      } else if (stageName == 'mint_failed') {
        stage(
          'mint_failed',
          finish['error']?.toString() ??
              'It left, but has not landed yet. Your money is safe.',
        );
      } else if (!ok) {
        stage('error', finish['error']?.toString() ?? 'Bridge finish failed');
      }

      return {
        ...finish,
        'ok': ok,
        'activityId': activityId,
        'burnChallengeId': burnChallengeId,
      };
    } catch (e) {
      debugPrint('circle cctp finish: $e');
      // PIN may have burned on-chain; leave activity for finish endpoint retry.
      // Do not force-confirm here — that overwrites failed/pending hash state.
      status = 'Burn may have succeeded — mint incomplete';
      notifyListeners();
      return {
        'ok': false,
        'error': e.toString(),
        'stage': 'finish_error',
        'activityId': activityId,
        'burnChallengeId': burnChallengeId,
        'partialBurn': true,
      };
    }
  }

  /// After burn: poll Iris + mint on destination (ops path via API).
  Future<Map<String, dynamic>> completeCctpMint({
    required String burnTxHash,
    required int destinationDomain,
    String? activityId,
  }) async {
    try {
      final res = await _api.post(
        '/v1/cctp/complete',
        body: {
          'burnTxHash': burnTxHash,
          'destinationDomain': destinationDomain,
          if (activityId != null) 'activityId': activityId,
        },
        timeout: const Duration(seconds: 150),
      );
      return {...res, 'ok': res['ok'] == true};
    } catch (e) {
      debugPrint('completeCctpMint: $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// Retry finish when burn tx is already known (attestation was pending).
  Future<Map<String, dynamic>> finishBridge({
    required String burnTxHash,
    required int destinationDomain,
    String? activityId,
  }) async {
    if (userToken == null) await refreshSessionOnly();
    try {
      final res = await _api.post(
        '/v1/circle/cctp/finish',
        body: {
          'userToken': userToken,
          'burnTxHash': burnTxHash,
          'destinationDomain': destinationDomain,
          if (activityId != null) 'activityId': activityId,
          'userId': _userId,
          'timeoutMs': 180000,
        },
        timeout: const Duration(seconds: 240),
      );
      return {...res, 'ok': res['ok'] == true};
    } catch (e) {
      debugPrint('finishBridge: $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// Self-link @handle on IdentityRegistry via UCW.
  Future<bool> linkIdentity({
    required BuildContext context,
    required String identifier,
    String kind = 'handle',
  }) async {
    if (!await ensureReady(context)) return false;
    final res = await _api.post('/v1/circle/identity/link', body: {
      'userToken': userToken,
      'walletId': walletId,
      'kind': kind,
      'identifier': identifier,
    });
    if (!context.mounted) return false;
    return executeChallengeResponse(context, res);
  }

  /// Product-supported deposit addresses (Arc / Eth Sepolia / Base Sepolia).
  List<Map<String, String>> depositAddressRows() {
    final rows = <Map<String, String>>[];
    final evm = address ?? '';
    const chains = [
      ('ARC-TESTNET', 'Arc Testnet'),
      ('ETH-SEPOLIA', 'Ethereum Sepolia'),
      ('BASE-SEPOLIA', 'Base Sepolia'),
    ];
    for (final (id, name) in chains) {
      String addr = evm;
      final entry = addressesByChain[id];
      if (entry is Map && entry['address'] != null) {
        addr = entry['address'].toString();
      }
      rows.add({
        'id': id,
        'name': name,
        'kind': 'evm',
        'address': addr,
        'note': 'Send money to this address to top up.',
      });
    }
    return rows;
  }

  /// Whether a payee already has an account, so we can offer to hold instead.
  ///
  /// Asked before anything is locked: paying an email that nobody has claimed
  /// yet is a deliberate choice, not something to discover afterwards.
  Future<Map<String, dynamic>> recipientStatus(String identifier) async {
    try {
      final res = await _api.get(
        '/v1/escrow/recipient-status?identifier=${Uri.encodeQueryComponent(identifier)}',
      );
      return {
        'ok': res['error'] == null,
        'registered': res['registered'] == true,
        'kind': res['kind']?.toString(),
        'identifier': res['identifier']?.toString() ?? identifier,
        if (res['error'] != null) 'error': res['error'].toString(),
      };
    } catch (e) {
      debugPrint('recipientStatus: $e');
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// Locks money in the escrow contract until it is claimed or released.
  ///
  /// One PIN: the server puts the approve, the lock and the Evabob fee in a
  /// single wallet batch. That batch's receipt carries the transfer id, and
  /// without that id nobody can ever claim or refund the hold, so the tx hash
  /// is resolved from the create challenge specifically.
  ///
  /// [purpose] is `claim_link` (someone not on Evabob yet), `job` (paid for
  /// work, released on delivery) or `cooling_off` (a first payment to someone
  /// new, sent after ten minutes unless cancelled).
  Future<Map<String, dynamic>> holdForRecipient({
    required BuildContext context,
    required String recipient,
    required double amountUsdc,
    String purpose = 'claim_link',
    String? memo,
    /// Paying through a seller's hold link. The server takes the seller,
    /// price and delivery window from the link itself.
    String? holdLinkId,
  }) async =>
      _outIfOk(await _holdForRecipient(
        context: context,
        recipient: recipient,
        amountUsdc: amountUsdc,
        purpose: purpose,
        memo: memo,
        holdLinkId: holdLinkId,
      ));

  Future<Map<String, dynamic>> _holdForRecipient({
    required BuildContext context,
    required String recipient,
    required double amountUsdc,
    String purpose = 'claim_link',
    String? memo,
    String? holdLinkId,
  }) async {
    if (!await ensureReady(context)) {
      return {'ok': false, 'error': 'Wallet not ready'};
    }
    await refreshSessionOnly();
    try {
      status = 'Preparing hold…';
      notifyListeners();

      final res = await _api.post('/v1/circle/escrow/hold', body: {
        'userToken': userToken,
        'walletId': walletId,
        'recipient': recipient,
        'amountUsdc': double.parse(amountUsdc.toStringAsFixed(6)),
        'purpose': purpose,
        if (memo != null && memo.isNotEmpty) 'memo': memo,
        if (holdLinkId != null) 'holdLinkId': holdLinkId,
      });
      if (!context.mounted) return {'ok': false, 'error': 'Cancelled'};

      final createChallengeId = res['createChallengeId']?.toString();
      final ids = _challengeIdsFrom(res);
      if (ids.isEmpty || createChallengeId == null) {
        final err = res['error']?.toString() ?? 'Could not prepare the hold';
        status = err;
        notifyListeners();
        return {'ok': false, 'error': err};
      }

      status = 'Confirm with your PIN…';
      notifyListeners();
      final pinOk = await executeChallengeResponse(
        context,
        res,
        title: 'Hold this payment',
      );
      if (!pinOk) {
        status = 'Hold cancelled — no funds moved';
        notifyListeners();
        return {'ok': false, 'error': 'PIN cancelled — no funds moved'};
      }

      status = 'Locking the funds…';
      notifyListeners();
      final verified = await verifyChallengesAndHash(
        challengeIds: [createChallengeId],
        resolveTxHash: true,
      );
      final createTx = verified['txHash']?.toString();
      if (createTx == null || createTx.isEmpty) {
        // The money may well be locked; we just cannot prove which transfer it
        // is yet. Say so rather than reporting either success or failure.
        status = 'Hold submitted — still confirming';
        notifyListeners();
        return {
          'ok': false,
          'pending': true,
          'error':
              'The hold was submitted but has not confirmed yet. Check Activity in a moment.',
        };
      }

      final record = await _api.post('/v1/escrow/protected/record', body: {
        'createTx': createTx,
        'recipient': recipient,
        'purpose': purpose,
        if (memo != null && memo.isNotEmpty) 'memo': memo,
        if (holdLinkId != null) 'holdLinkId': holdLinkId,
      });
      if (record['error'] != null) {
        return {
          'ok': false,
          'error': record['error'].toString(),
          'txHash': createTx
        };
      }

      status = 'Held';
      notifyListeners();
      return {
        'ok': true,
        'txHash': createTx,
        'transferId': record['transferId']?.toString(),
        'emailed': record['emailed'] == true,
        'expiresAt': record['expiresAt']?.toString(),
        'amountUsdc': amountUsdc,
      };
    } catch (e) {
      debugPrint('holdForRecipient: $e');
      status = 'Hold failed';
      notifyListeners();
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// Pays an invoice by milestone: one hold per line, all set aside under a
  /// single PIN. Each is paid to the invoice's sender as that part is
  /// delivered, under the same rules as any job hold.
  Future<Map<String, dynamic>> holdMilestones({
    required BuildContext context,
    required String paymentRequestId,
  }) async =>
      _outIfOk(await _holdMilestones(
        context: context,
        paymentRequestId: paymentRequestId,
      ));

  Future<Map<String, dynamic>> _holdMilestones({
    required BuildContext context,
    required String paymentRequestId,
  }) async {
    if (!await ensureReady(context)) {
      return {'ok': false, 'error': 'Wallet not ready'};
    }
    await refreshSessionOnly();
    try {
      status = 'Preparing milestones…';
      notifyListeners();
      final res = await _api.post('/v1/circle/escrow/hold-milestones', body: {
        'userToken': userToken,
        'walletId': walletId,
        'paymentRequestId': paymentRequestId,
      });
      if (!context.mounted) return {'ok': false, 'error': 'Cancelled'};
      final createChallengeId = res['createChallengeId']?.toString();
      if (createChallengeId == null || _challengeIdsFrom(res).isEmpty) {
        return {
          'ok': false,
          'error': res['error']?.toString() ?? 'Could not prepare the milestones',
        };
      }
      status = 'Confirm with your PIN…';
      notifyListeners();
      final pinOk = await executeChallengeResponse(
        context,
        res,
        title: 'Set aside each milestone',
      );
      if (!pinOk) {
        status = 'Cancelled — no funds moved';
        notifyListeners();
        return {'ok': false, 'error': 'PIN cancelled — no funds moved'};
      }
      status = 'Setting the money aside…';
      notifyListeners();
      final verified = await verifyChallengesAndHash(
        challengeIds: [createChallengeId],
        resolveTxHash: true,
      );
      final createTx = verified['txHash']?.toString();
      if (createTx == null || createTx.isEmpty) {
        return {
          'ok': false,
          'pending': true,
          'error': 'Submitted but not confirmed yet. Check Activity in a moment.',
        };
      }
      final recorded = await _api.post(
        '/v1/payment-requests/$paymentRequestId/milestones-held',
        body: {'createTx': createTx},
      );
      status = 'Held';
      notifyListeners();
      return {
        'ok': true,
        'txHash': createTx,
        'transferIds': (recorded['transferIds'] as List?)
                ?.map((e) => e.toString())
                .toList() ??
            const <String>[],
      };
    } catch (e) {
      debugPrint('holdMilestones: $e');
      status = 'Milestones failed';
      notifyListeners();
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// One group-money action: the server builds a wallet batch at [path], the
  /// person confirms with their PIN, and the transaction is handed to
  /// [confirmPath] (when given) so the server can read what it did.
  ///
  /// Returns `ok`, the `groupId`, the `txHash`, and the confirmed `item`.
  Future<Map<String, dynamic>> _groupAction({
    required BuildContext context,
    required String path,
    required Map<String, dynamic> body,
    required String title,
    String Function(String groupId)? confirmPath,
  }) async {
    if (!await ensureReady(context)) {
      return {'ok': false, 'error': 'Wallet not ready'};
    }
    await refreshSessionOnly();
    try {
      status = 'Preparing…';
      notifyListeners();
      final res = await _api.post(path, body: {
        'userToken': userToken,
        'walletId': walletId,
        ...body,
      });
      if (!context.mounted) return {'ok': false, 'error': 'Cancelled'};
      final challengeId = res['createChallengeId']?.toString();
      final groupId = res['groupId']?.toString() ?? '';
      if (challengeId == null || _challengeIdsFrom(res).isEmpty) {
        return {'ok': false, 'error': res['error']?.toString() ?? 'Could not prepare that'};
      }
      status = 'Confirm with your PIN…';
      notifyListeners();
      if (!await executeChallengeResponse(context, res, title: title)) {
        status = 'Cancelled — no funds moved';
        notifyListeners();
        return {'ok': false, 'error': 'PIN cancelled — no funds moved'};
      }
      status = 'Confirming…';
      notifyListeners();
      final verified = await verifyChallengesAndHash(
        challengeIds: [challengeId],
        resolveTxHash: true,
      );
      final txHash = verified['txHash']?.toString();
      if (txHash == null || txHash.isEmpty) {
        return {
          'ok': false,
          'pending': true,
          'groupId': groupId,
          'error': 'Submitted but not confirmed yet. Check again in a moment.',
        };
      }
      Map<String, dynamic>? item;
      if (confirmPath != null) {
        final confirmed = await _api.post(confirmPath(groupId), body: {'txHash': txHash});
        item = confirmed['item'] is Map
            ? Map<String, dynamic>.from(confirmed['item'] as Map)
            : null;
      }
      status = 'Done';
      notifyListeners();
      return {'ok': true, 'groupId': groupId, 'txHash': txHash, 'item': item};
    } catch (e) {
      debugPrint('group action: $e');
      status = 'Failed';
      notifyListeners();
      return {'ok': false, 'error': e.toString()};
    }
  }

  /// Starts a money circle. If the organizer is a member, joining (and the
  /// approval for their whole commitment) is in the same confirmation.
  Future<Map<String, dynamic>> createCircle({
    required BuildContext context,
    required String name,
    required double contributionUsdc,
    required String every,
    required List<String> members,
    DateTime? startAt,
  }) =>
      _groupAction(
        context: context,
        path: '/v1/circle/groups/circles',
        body: {
          'name': name,
          'contributionUsdc': contributionUsdc,
          'every': every,
          'members': members,
          if (startAt != null) 'startAt': startAt.toUtc().toIso8601String(),
        },
        title: 'Start the circle',
        confirmPath: (id) => '/v1/groups/circles/$id/confirm',
      );

  /// Joins a circle: approves the whole commitment and joins, one PIN.
  Future<Map<String, dynamic>> joinCircle({
    required BuildContext context,
    required String circleId,
  }) =>
      _groupAction(
        context: context,
        path: '/v1/circle/groups/circles/$circleId/join',
        body: const {},
        title: 'Join the circle',
        confirmPath: (id) => '/v1/groups/circles/$id/sync',
      );

  Future<Map<String, dynamic>> createPot({
    required BuildContext context,
    required String title,
    String? description,
    required double targetUsdc,
    required DateTime deadline,
    String? beneficiary,
  }) =>
      _groupAction(
        context: context,
        path: '/v1/circle/groups/pots',
        body: {
          'title': title,
          if (description != null && description.isNotEmpty)
            'description': description,
          'targetUsdc': targetUsdc,
          'deadline': deadline.toUtc().toIso8601String(),
          if (beneficiary != null && beneficiary.isNotEmpty)
            'beneficiary': beneficiary,
        },
        title: 'Start the collection',
        confirmPath: (id) => '/v1/groups/pots/$id/confirm',
      );

  Future<Map<String, dynamic>> contributeToPot({
    required BuildContext context,
    required String potId,
    required double amountUsdc,
  }) =>
      _groupAction(
        context: context,
        path: '/v1/circle/groups/pots/$potId/contribute',
        body: {'amountUsdc': double.parse(amountUsdc.toStringAsFixed(6))},
        title: 'Chip in',
        confirmPath: (id) => '/v1/groups/pots/$id/contributed',
      ).then(_outIfOk);

  /// Money this user is holding for someone else, newest first.
  ///
  /// Carries the on-chain transfer id, which is what a release needs and what
  /// an activity row does not have.
  Future<List<Map<String, dynamic>>> listHeldPayments() async {
    try {
      final res = await _api.get('/v1/escrow/protected');
      final items = (res['items'] as List?) ?? const [];
      return items
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList(growable: false);
    } catch (e) {
      debugPrint('listHeldPayments: $e');
      return const [];
    }
  }

  /// Releases a hold to the person it was locked for.
  ///
  /// Payer only, and the server picks the destination from the stored record —
  /// the caller cannot name an address, or releasing would just be a transfer
  /// to anywhere.
  Future<Map<String, dynamic>> releaseHold(String transferId) async {
    try {
      final res =
          await _api.post('/v1/escrow/protected/$transferId/release', body: {});
      if (res['error'] != null) {
        return {'ok': false, 'error': res['error'].toString()};
      }
      return {
        'ok': res['ok'] == true,
        'txHash': res['claimTx']?.toString(),
        'amountUsdc': (res['amountUsdc'] as num?)?.toDouble(),
      };
    } catch (e) {
      debugPrint('releaseHold: $e');
      return {'ok': false, 'error': e.toString()};
    }
  }
}

String? _str(dynamic v) {
  if (v == null) return null;
  final s = v.toString().trim();
  return s.isEmpty ? null : s;
}

class CircleOnboardResult {
  CircleOnboardResult({
    required this.needsChallenge,
    this.challengeId,
    this.userToken,
    this.encryptionKey,
    this.appId,
    this.address,
    this.walletId,
    this.followUpChallenges = const [],
  });

  final bool needsChallenge;
  final String? challengeId;
  final String? userToken;
  final String? encryptionKey;
  final String? appId;
  final String? address;
  final String? walletId;
  final List<Map<String, dynamic>> followUpChallenges;
}
