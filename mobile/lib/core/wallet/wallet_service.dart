import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../api/api_client.dart';
import '../auth/evabob_auth.dart';

class DepositChain {
  DepositChain({
    required this.id,
    required this.name,
    required this.family,
    required this.kind,
    required this.address,
    required this.asset,
    required this.note,
    this.domain,
  });

  factory DepositChain.fromJson(Map<String, dynamic> j) => DepositChain(
        id: j['id']?.toString() ?? '',
        name: j['name']?.toString() ?? '',
        family: j['family']?.toString() ?? '',
        kind: j['kind']?.toString() ?? '',
        address: j['address']?.toString() ?? '',
        asset: j['asset']?.toString() ?? 'USDC',
        note: j['note']?.toString() ?? '',
        domain: j['domain'] is num ? (j['domain'] as num).toInt() : null,
      );

  final String id;
  final String name;
  final String family;
  final String kind;
  final String address;
  final String asset;
  final String note;
  final int? domain;
}

class GatewayChainBalance {
  GatewayChainBalance({
    required this.domain,
    required this.balanceUsdc,
    this.name,
    this.chainId,
    this.balanceRaw,
  });

  /// Reads a raw `balance` in either form the server may send.
  ///
  /// Most paths emit atomic units ("1000000"), but the legacy Gateway
  /// fallback passes Circle's own value straight through, and that is a
  /// decimal string ("1.000000"). Dividing the decimal form by 1e6 turns a
  /// real 1 USDC into 0.000001 — the same million-fold error that was fixed
  /// server-side. Deciding on the decimal point handles both.
  static double _balanceToUsdc(dynamic raw) {
    if (raw == null) return 0;
    if (raw is num) return raw.toDouble() / 1e6; // numeric is always atomic
    final s = raw.toString().trim();
    if (s.isEmpty) return 0;
    final n = double.tryParse(s);
    if (n == null) return 0;
    return s.contains('.') ? n : n / 1e6;
  }

  factory GatewayChainBalance.fromJson(Map<String, dynamic> j) =>
      GatewayChainBalance(
        domain: (j['domain'] as num?)?.toInt() ?? -1,
        // Prefer the server's already-converted figure; fall back to parsing
        // the raw balance only when it is absent.
        balanceUsdc: (j['balanceUsdc'] as num?)?.toDouble() ??
            _balanceToUsdc(j['balance']),
        name: j['name']?.toString(),
        chainId: j['chainId']?.toString(),
        balanceRaw: j['balance']?.toString(),
      );

  final int domain;
  final double balanceUsdc;
  final String? name;
  final String? chainId;
  final String? balanceRaw;
}

/// How far a Gateway deposit had got by the time we stopped watching.
///
/// Gateway credits a deposit only once it is final on the source chain, and
/// that varies enormously: seconds on Arc, roughly 42 minutes for a measured
/// Base Sepolia deposit. The app cannot wait that long, so the UI needs to
/// tell "it arrived" apart from "it is still on its way" — reporting the
/// second as a failure is what made working top-ups look broken.
enum DepositWatch {
  /// Confirmed balance went up. Done.
  credited,

  /// Gateway can see the deposit but has not finalised it yet.
  pending,

  /// Sent and accepted on chain, not yet visible in the unified balance.
  stillSettling,
}

/// Live balances + Gateway deposit/withdraw via backend.
class WalletService extends ChangeNotifier {
  WalletService(this._api, this._auth);

  final ApiClient _api;
  final EvabobAuth _auth;

  double usdcWallet = 0;
  double eurcWallet = 0;
  double cirbtcWallet = 0;
  double gatewayUsdc = 0;
  double gatewayConfirmedUsdc = 0;
  double gatewayPendingUsdc = 0;
  double totalUsdc = 0;
  String? address;
  String? error;
  bool loading = false;
  List<DepositChain> depositChains = [];

  /// Takes a payment that just went through off the balance on screen at
  /// once. The next read from the server replaces it with the real figure.
  void applySpend(String token, double amount) {
    if (!(amount > 0)) return;
    switch (token.toUpperCase()) {
      case 'EURC':
        eurcWallet = (eurcWallet - amount).clamp(0, double.infinity);
      case 'CIRBTC':
        cirbtcWallet = (cirbtcWallet - amount).clamp(0, double.infinity);
      default:
        usdcWallet = (usdcWallet - amount).clamp(0, double.infinity);
        totalUsdc = (totalUsdc - amount).clamp(0, double.infinity);
    }
    notifyListeners();
  }

  /// Per-domain Gateway USDC (unified balance breakdown).
  List<GatewayChainBalance> gatewayBalances = [];

  /// Per-chain wallet balances (USDC / EURC / cirBTC) from public RPCs.
  List<Map<String, dynamic>> chainBalances = [];

  /// Address whose saved balances have been painted this session.
  String? _restoredFor;

  static String _snapshotKey(String addr) =>
      'wallet.balances.${addr.toLowerCase()}';

  /// Paints the balances saved on the last successful read, so a cold start
  /// shows money at once instead of zero while the network catches up.
  Future<void> _restoreSnapshot(String addr) async {
    if (_restoredFor == addr.toLowerCase()) return;
    _restoredFor = addr.toLowerCase();
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_snapshotKey(addr));
      if (raw == null) return;
      final j = jsonDecode(raw);
      if (j is! Map) return;
      // A read that already landed wins over the saved copy.
      if (_lastRefreshAt != null) return;
      usdcWallet = _asDouble(j['usdcWallet']) ?? usdcWallet;
      eurcWallet = _asDouble(j['eurcWallet']) ?? eurcWallet;
      cirbtcWallet = _asDouble(j['cirbtcWallet']) ?? cirbtcWallet;
      gatewayUsdc = _asDouble(j['gatewayUsdc']) ?? gatewayUsdc;
      gatewayConfirmedUsdc =
          _asDouble(j['gatewayConfirmedUsdc']) ?? gatewayConfirmedUsdc;
      gatewayPendingUsdc =
          _asDouble(j['gatewayPendingUsdc']) ?? gatewayPendingUsdc;
      totalUsdc = usdcWallet + gatewayUsdc;
      final gb = j['gatewayBalances'];
      if (gb is List) {
        gatewayBalances = gb
            .whereType<Map>()
            .map((e) =>
                GatewayChainBalance.fromJson(Map<String, dynamic>.from(e)))
            .toList();
      }
      final cb = j['chainBalances'];
      if (cb is List) {
        chainBalances =
            cb.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
      }
      address ??= addr;
      notifyListeners();
    } catch (e) {
      debugPrint('restore balances: $e');
    }
  }

  Future<void> _saveSnapshot(String addr) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        _snapshotKey(addr),
        jsonEncode({
          'usdcWallet': usdcWallet,
          'eurcWallet': eurcWallet,
          'cirbtcWallet': cirbtcWallet,
          'gatewayUsdc': gatewayUsdc,
          'gatewayConfirmedUsdc': gatewayConfirmedUsdc,
          'gatewayPendingUsdc': gatewayPendingUsdc,
          'gatewayBalances': [
            for (final b in gatewayBalances)
              {
                'domain': b.domain,
                'balanceUsdc': b.balanceUsdc,
                'name': b.name,
                'chainId': b.chainId,
              },
          ],
          'chainBalances': chainBalances,
        }),
      );
    } catch (e) {
      debugPrint('save balances: $e');
    }
  }

  /// Wipe balances when switching accounts so UI never shows another user's funds.
  void reset() {
    _restoredFor = null;
    _lastRefreshAt = null;
    usdcWallet = 0;
    eurcWallet = 0;
    cirbtcWallet = 0;
    gatewayUsdc = 0;
    gatewayConfirmedUsdc = 0;
    gatewayPendingUsdc = 0;
    totalUsdc = 0;
    address = null;
    error = null;
    loading = false;
    depositChains = [];
    gatewayBalances = [];
    chainBalances = [];
    notifyListeners();
  }

  Map<String, dynamic>? chainRow(String id) {
    for (final r in chainBalances) {
      if (r['id']?.toString() == id) return r;
    }
    return null;
  }

  /// USDC available on a Gateway domain (0 if none).
  double usdcOnDomain(int domain) {
    for (final b in gatewayBalances) {
      if (b.domain == domain) return b.balanceUsdc;
    }
    return 0;
  }

  Future<void> syncSession() async {
    final u = _auth.user;
    if (u == null) return;
    // Always use Circle-mapped id so server + UCW stay aligned.
    final circleId = _auth.circleUserId;
    _api.setUserId(circleId);
    try {
      final body = <String, dynamic>{
        'id': circleId,
        'email': u.email.isNotEmpty ? u.email : '$circleId@evabob.app',
        'displayName': u.displayName,
      };
      // Only attach wallet when we have a real address for THIS session.
      final addr = u.smartAccount;
      if (addr.startsWith('0x') && addr.length == 42) {
        body['evmAddress'] = addr;
      }
      final res = await _api.post('/v1/users/session', body: body);
      // Hydrate permanent phone link + profile from server (survives cold start).
      final serverUser = res['user'];
      if (serverUser is Map) {
        await _auth.applyServerProfile(Map<String, dynamic>.from(serverUser));
      } else {
        try {
          final me = await _api.get('/v1/users/me');
          final mu = me['user'];
          if (mu is Map) {
            await _auth.applyServerProfile(Map<String, dynamic>.from(mu));
          }
        } catch (_) {}
      }
      // Session may have reattached a Circle SCA for this email — use it
      // immediately so Home/Profile don't stay on "Not linked yet".
      final bound = _auth.user?.smartAccount;
      if (bound != null && bound.startsWith('0x') && bound.length == 42) {
        address = bound;
      }
    } catch (e) {
      debugPrint('session sync: $e');
    }
  }

  /// Monotonic id so a slow response can never overwrite a newer one.
  int _refreshSeq = 0;

  /// Coalesces the burst of refreshes that auth/profile notifications trigger.
  Future<void>? _inFlight;
  String? _inFlightAddr;
  DateTime? _lastRefreshAt;
  static const _minRefreshInterval = Duration(seconds: 12);

  String? _effectiveAddress(String? addressOverride) {
    final addr = addressOverride ?? _auth.user?.smartAccount ?? address;
    if (addr != null && addr.startsWith('0x') && addr.length == 42) return addr;
    return null;
  }

  static double? _asDouble(dynamic v) => v is num ? v.toDouble() : null;

  double _arcTokenFromChains(List<Map<String, dynamic>> rows, String key) {
    for (final r in rows) {
      final id = r['id']?.toString() ?? '';
      final domain = (r['domain'] as num?)?.toInt();
      if (id == 'arc' || domain == 26) {
        return (r[key] as num?)?.toDouble() ?? 0;
      }
    }
    return 0;
  }

  /// USDC available on a CCTP/product chain (wallet holdings, not Gateway).
  double usdcOnSourceDomain(int domain) {
    if (domain == 26) return usdcWallet;
    for (final r in chainBalances) {
      final d = (r['domain'] as num?)?.toInt();
      if (d == domain) return (r['usdc'] as num?)?.toDouble() ?? 0;
    }
    return 0;
  }

  /// Native USDC on a product chain id (`arc`, `ethereum-sepolia`, `base-sepolia`).
  double usdcOnChainId(String id) {
    if (id == 'arc') return usdcWallet;
    final r = chainRow(id);
    return (r?['usdc'] as num?)?.toDouble() ?? 0;
  }

  /// Wallet-held token on a product CCTP domain (26 Arc, 0 Eth, 6 Base).
  double tokenOnSourceDomain(int domain, String symbol) {
    final key = symbol.trim().toUpperCase() == 'CIRBTC'
        ? 'cirbtc'
        : symbol.trim().toLowerCase();
    if (domain == 26) {
      if (key == 'usdc') return usdcWallet;
      if (key == 'eurc') return eurcWallet;
      if (key == 'cirbtc') return cirbtcWallet;
    }
    for (final r in chainBalances) {
      if ((r['domain'] as num?)?.toInt() == domain) {
        return (r[key] as num?)?.toDouble() ?? 0;
      }
    }
    return 0;
  }

  /// [force] bypasses throttle (pull-to-refresh, post-tx).
  /// [silent] skips the loading spinner so the home card stays steady.
  Future<void> refreshBalances({
    String? addressOverride,
    bool force = false,
    bool silent = false,
  }) {
    var addr = _effectiveAddress(addressOverride);
    // First paint often runs before Circle session restore. If we still have
    // no address, let syncSession inside _refreshBalances attach one and
    // never skip that pass via the 12s throttle.
    final missingAddr = addr == null;
    if (!force &&
        !missingAddr &&
        _lastRefreshAt != null &&
        DateTime.now().difference(_lastRefreshAt!) < _minRefreshInterval) {
      return _inFlight ?? Future<void>.value();
    }
    final existing = _inFlight;
    if (existing != null && _inFlightAddr == addr && !force) return existing;
    final seq = ++_refreshSeq;
    late final Future<void> f;
    f = _refreshBalances(addr, seq, silent: silent).whenComplete(() {
      if (identical(_inFlight, f)) {
        _inFlight = null;
        _inFlightAddr = null;
      }
    });
    _inFlight = f;
    _inFlightAddr = addr;
    return f;
  }

  Future<void> _refreshBalances(
    String? addr,
    int seq, {
    required bool silent,
  }) async {
    if (!silent) {
      loading = true;
      error = null;
      notifyListeners();
    }
    try {
      if (addr != null) {
        await _restoreSnapshot(addr);
        // The wallet is already known, so the session sync (a server round
        // trip of its own) no longer has to finish before the balances are
        // asked for. It used to, and the Arc figure paid for it.
        unawaited(syncSession());
      } else {
        await syncSession();
        // Session may have just rebound the SCA — pick it up for this request.
        addr = _effectiveAddress(null);
      }
      final q = <String, String>{};
      if (addr != null) q['address'] = addr;
      final data = await _api.get('/v1/wallet/balances', query: q);
      if (seq != _refreshSeq) return;
      // Transient miss while we already know the wallet — keep last numbers.
      if (data['source']?.toString() == 'empty' && addr != null) return;

      // null/absent field = unreadable this round, not zero.
      usdcWallet = _asDouble(data['usdcWallet']) ?? usdcWallet;
      eurcWallet = _asDouble(data['eurcWallet']) ?? eurcWallet;
      cirbtcWallet = _asDouble(data['cirbtcWallet']) ?? cirbtcWallet;
      gatewayUsdc = _asDouble(data['gatewayUsdc']) ?? gatewayUsdc;
      gatewayConfirmedUsdc =
          _asDouble(data['gatewayConfirmedUsdc']) ?? gatewayConfirmedUsdc;
      gatewayPendingUsdc =
          _asDouble(data['gatewayPendingUsdc']) ?? gatewayPendingUsdc;
      totalUsdc = _asDouble(data['totalUsdc']) ?? (usdcWallet + gatewayUsdc);
      address = data['address']?.toString() ?? addr ?? address;
      final linked = address;
      if (linked != null &&
          linked.startsWith('0x') &&
          linked.length == 42 &&
          (_auth.user?.smartAccount.isEmpty ?? true)) {
        _auth.bindExternalWallet(linked);
      }
      final gb = data['gatewayBalances'];
      if (gb is List) {
        gatewayBalances = gb
            .whereType<Map>()
            .map(
              (e) => GatewayChainBalance.fromJson(Map<String, dynamic>.from(e)),
            )
            .toList();
      }
      final cb = data['chainBalances'];
      if (cb is List) {
        chainBalances = cb
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        final altUsdc = _arcTokenFromChains(chainBalances, 'usdc');
        final altEurc = _arcTokenFromChains(chainBalances, 'eurc');
        final altCirbtc = _arcTokenFromChains(chainBalances, 'cirbtc');
        if (altUsdc > usdcWallet) usdcWallet = altUsdc;
        if (altEurc > eurcWallet) eurcWallet = altEurc;
        if (altCirbtc > cirbtcWallet) cirbtcWallet = altCirbtc;
      }
      if (data['gatewayError'] != null) {
        error = data['gatewayError']?.toString();
      } else if (data['onchainError'] != null) {
        error = data['onchainError']?.toString();
      } else {
        error = null;
      }
      _lastRefreshAt = DateTime.now();
      final saved = address;
      if (saved != null && saved.startsWith('0x')) {
        unawaited(_saveSnapshot(saved));
      }
    } catch (e) {
      if (seq == _refreshSeq) error = e.toString();
      debugPrint('refreshBalances: $e');
    } finally {
      if (seq == _refreshSeq) {
        loading = false;
        notifyListeners();
      }
    }
  }

  /// After App Kit deposit, wait for finality then poll unified only (soft).
  /// Outcome of watching for a deposit to appear in the unified balance.
  ///
  /// Gateway only credits once the deposit is final on its source chain. That
  /// is seconds on Arc, but a measured Base Sepolia deposit took about 42
  /// minutes — far longer than any reasonable in-app wait. So "we stopped
  /// looking" has to be distinguishable from "it failed", otherwise a
  /// perfectly good deposit reads as a broken one.
  Future<DepositWatch> pollUnifiedBalanceAfterDeposit({
    String? addressOverride,
    double? previousGatewayUsdc,
    int attempts = 10,
    Duration delay = const Duration(seconds: 4),
    Duration initialDelay = const Duration(seconds: 6),
  }) async {
    final prev = previousGatewayUsdc ?? gatewayUsdc;
    final prevConfirmed = gatewayConfirmedUsdc;
    await Future<void>.delayed(initialDelay);
    for (var i = 0; i < attempts; i++) {
      try {
        final addr = addressOverride ?? _auth.user?.smartAccount ?? address;
        if (addr != null && addr.startsWith('0x') && addr.length == 42) {
          final kit = await _api.get(
            '/v1/app-kit/balances',
            query: {
              'address': addr,
              'includePending': 'true',
            },
          );
          final conf = (kit['confirmedUsdc'] as num?)?.toDouble();
          final pend = (kit['pendingUsdc'] as num?)?.toDouble();
          if (conf != null) gatewayConfirmedUsdc = conf;
          if (pend != null) gatewayPendingUsdc = pend;
          if (conf != null || pend != null) {
            final sum = (conf ?? 0) + (pend ?? 0);
            gatewayUsdc = sum > 0 ? sum : (conf ?? gatewayUsdc);
            // Unified-only notify — do not touch native Arc balances.
            notifyListeners();
          }
        }
      } catch (e) {
        debugPrint('app-kit balances poll: $e');
      }
      // Full merge once per loop (throttled / silent) so USDC/EURC/cirBTC stay.
      await refreshBalances(
        addressOverride: addressOverride,
        force: true,
        silent: true,
      );
      if (gatewayUsdc > prev + 1e-9 ||
          gatewayConfirmedUsdc > prevConfirmed + 1e-9) {
        return DepositWatch.credited;
      }
      if (gatewayPendingUsdc > 1e-9) return DepositWatch.pending;
      await Future<void>.delayed(delay);
    }
    // The deposit transaction succeeded; Gateway just has not finalised it in
    // the time we were willing to wait.
    return DepositWatch.stillSettling;
  }

  Future<void> loadDepositAddresses() async {
    try {
      await syncSession();
      final q = <String, String>{};
      final addr = _auth.user?.smartAccount;
      if (addr != null && addr.isNotEmpty) q['evm'] = addr;
      final data = await _api.get('/v1/wallet/deposit-addresses', query: q);
      final list = data['chains'] as List? ?? [];
      depositChains = list
          .whereType<Map>()
          .map((e) => DepositChain.fromJson(Map<String, dynamic>.from(e)))
          .toList();
      notifyListeners();
    } catch (e) {
      debugPrint('deposit addresses: $e');
    }
  }

  Future<Map<String, dynamic>> withdraw({
    required double amountUsdc,
    required int destinationDomain,
    required String destinationAddress,
  }) async {
    return _api.post('/v1/wallet/withdraw', body: {
      'amountUsdc': amountUsdc,
      'destinationDomain': destinationDomain,
      'destinationAddress': destinationAddress,
    });
  }

  Future<Map<String, dynamic>> send({
    required String to,
    required double amountUsdc,
    required double amountNgn,
    String? memo,
  }) async {
    final res = await _api.post('/v1/transfers/send', body: {
      'to': to,
      'amountUsdc': amountUsdc,
      'amountNgn': amountNgn,
      if (memo != null) 'memo': memo,
    });
    await refreshBalances();
    return res;
  }

  /// Live quote from App Kit — the same route the swap then takes.
  /// [from]/[to] may be symbols or 0x contract addresses.
  Future<Map<String, dynamic>> quoteExchange({
    required String from,
    required String to,
    required double amountIn,
  }) async {
    return _api.post('/v1/app-kit/swap/quote', body: {
      'from': from,
      'to': to,
      'amountIn': amountIn,
    });
  }

  /// App Kit hop quote: USDC is 1:1 CCTP; EURC/cirBTC is swap→USDC then CCTP.
  Future<Map<String, dynamic>> quoteAppKitBridge({
    required double amount,
    required String fromChain,
    required String toChain,
    required String token,
  }) {
    return _api.post('/v1/app-kit/bridge/quote', body: {
      'amount': amount,
      'fromChain': fromChain,
      'toChain': toChain,
      'token': token,
    });
  }

  /// @deprecated Use [CircleWalletService.gatewayPay] — ops-only server path.
  Future<Map<String, dynamic>> gatewayPay({
    required double amountUsdc,
    required int destinationDomain,
    required String destinationAddress,
    int? sourceDomain,
  }) async {
    throw StateError(
      'Use CircleWalletService.gatewayPay — user pays must go through '
      'POST /v1/circle/gateway/pay (not ops wallet/withdraw).',
    );
  }
}
