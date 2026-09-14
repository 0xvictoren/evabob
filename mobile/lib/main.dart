import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'core/activity/activity_service.dart';
import 'core/agents/agent_service.dart';
import 'core/api/api_client.dart';
import 'core/auth/evabob_auth.dart';
import 'core/chat/chat_service.dart';
import 'core/chat/pusher_service.dart';
import 'core/notifications/money_alerts.dart';
import 'core/navigation/app_link_service.dart';
import 'core/config/env.dart';
import 'core/config/app_features.dart';
import 'core/contacts/contacts_service.dart';
import 'core/fx/fx_service.dart';
import 'core/notify/section_notify.dart';
import 'core/security/app_lock_service.dart';
import 'core/theme/evabob_colors.dart';
import 'core/theme/evabob_theme.dart';
import 'core/theme/theme_controller.dart';
import 'core/wallet/circle_wallet_service.dart';
import 'core/wallet/wallet_service.dart';
import 'features/auth/app_lock_screen.dart';
import 'features/auth/login_screen.dart';
import 'features/onboarding/post_signup_onboarding.dart';
import 'features/shell/app_shell.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
  ]);
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  Env.warnIfApiBaseUnsafe();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.dark,
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarIconBrightness: Brightness.dark,
    ),
  );
  runApp(const EvabobApp());
}

/// Injectable application graph. Production uses [production]; widget and
/// integration tests can supply controlled service instances without starting
/// Dynamic, Pusher or network polling as a side effect of `pumpWidget`.
class EvabobServices {
  EvabobServices({
    required this.api,
    required this.fx,
    required this.auth,
    required this.chat,
    required this.wallet,
    required this.circle,
    required this.activity,
    required this.agents,
    required this.contacts,
    required this.theme,
    required this.pusher,
    required this.moneyAlerts,
    required this.notify,
    required this.appLock,
    required this.features,
    required this.appLinks,
  });

  factory EvabobServices.production() {
    final api = ApiClient(baseUrl: Env.resolveApiBaseUrl());
    final fx = FxService(apiBaseUrl: Env.resolveApiBaseUrl())..start();
    final auth = EvabobAuth(api: api)..init();
    final notify = SectionNotify();
    final pusher = PusherService()..init();
    return EvabobServices(
      api: api,
      fx: fx,
      auth: auth,
      chat: ChatService(fx, api, notify: notify),
      wallet: WalletService(api, auth),
      circle: CircleWalletService(api, auth),
      activity: ActivityService(api, fx),
      agents: AgentService(api),
      contacts: ContactsService(api),
      theme: ThemeController(),
      pusher: pusher,
      moneyAlerts: MoneyAlerts(pusher),
      notify: notify,
      appLock: AppLockService()..init(),
      features: AppFeatures(api)..refresh(),
      appLinks: AppLinkService()..init(),
    );
  }

  final ApiClient api;
  final FxService fx;
  final EvabobAuth auth;
  final ChatService chat;
  final WalletService wallet;
  final CircleWalletService circle;
  final ActivityService activity;
  final AgentService agents;
  final ContactsService contacts;
  final ThemeController theme;
  final PusherService pusher;
  final MoneyAlerts moneyAlerts;
  final SectionNotify notify;
  final AppLockService appLock;
  final AppFeatures features;
  final AppLinkService appLinks;
}

class EvabobApp extends StatefulWidget {
  const EvabobApp({super.key, this.services, this.homeOverride});

  final EvabobServices? services;

  /// Small boot-surface seam for widget tests. No production service is
  /// created when supplied.
  final Widget? homeOverride;

  @override
  State<EvabobApp> createState() => _EvabobAppState();
}

class _EvabobAppState extends State<EvabobApp> with WidgetsBindingObserver {
  late final ApiClient _api;
  late final FxService _fx;
  late final EvabobAuth _auth;
  late final ChatService _chat;
  late final WalletService _wallet;
  late final CircleWalletService _circle;
  late final ActivityService _activity;
  late final AgentService _agents;
  late final ContactsService _contacts;
  late final ThemeController _theme;
  late final PusherService _pusher;
  late final MoneyAlerts _moneyAlerts;
  late final SectionNotify _notify;
  late final AppLockService _appLock;
  late final AppFeatures _features;
  late final AppLinkService _appLinks;
  late final bool _ownsServices;

  @override
  void initState() {
    super.initState();
    if (widget.homeOverride != null) return;
    WidgetsBinding.instance.addObserver(this);
    final services = widget.services ?? EvabobServices.production();
    _ownsServices = widget.services == null;
    _api = services.api;
    _fx = services.fx;
    _auth = services.auth;
    _chat = services.chat;
    _wallet = services.wallet;
    _circle = services.circle;
    _activity = services.activity;
    _agents = services.agents;
    _contacts = services.contacts;
    _theme = services.theme;
    _pusher = services.pusher;
    _moneyAlerts = services.moneyAlerts;
    _notify = services.notify;
    _appLock = services.appLock;
    _features = services.features;
    _appLinks = services.appLinks;
    _auth.addListener(_onAuth);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Only lock when app is backgrounded — not on inactive (PIN WebView overlays).
    if (state == AppLifecycleState.paused) {
      _appLock.lockNow();
    }
    if (state == AppLifecycleState.resumed) {
      // Startup may have raced an unreachable API; never stay fail-closed
      // for the rest of the session once the server is back.
      _features.refresh();
    }
    if (state == AppLifecycleState.resumed && _auth.user != null) {
      _circle.refreshOpenJobs();
      _activity.refresh();
    }
  }

  String? _lastCircleUserId;
  Timer? _authDebounce;

  void _onAuth() {
    _authDebounce?.cancel();
    _authDebounce = Timer(const Duration(milliseconds: 350), _applyAuth);
  }

  void _applyAuth() {
    final u = _auth.user;
    final circleId = u != null ? _auth.circleUserId : null;

    // Hard isolation: different email/login must never keep prior wallet/activity.
    if (circleId == null ||
        (_lastCircleUserId != null && _lastCircleUserId != circleId)) {
      _circle.reset();
      _wallet.reset();
      _activity.clear();
    }
    _lastCircleUserId = circleId;

    if (u != null) {
      _api.setUserId(circleId!);
      _api.setAuthToken(u.authToken);
      // Pusher authorizes channel subscriptions against the same session.
      _pusher.setAuthToken(u.authToken);
      // Listening starts once the session can authorise the channel.
      _moneyAlerts.start(circleId);
      _wallet.syncSession().then((_) {
        _features.refresh();
        // Prefer live Circle address once ready; fall back to the SCA the
        // server rebound for this email so Home isn't stuck at $0.
        _circle.hydrateDisplayAddress(_auth.user?.smartAccount);
        _wallet.refreshBalances(
          addressOverride: _circle.address ?? _auth.user?.smartAccount,
          silent: true,
        );
        _activity.refresh();
        _chat.refreshThreads();
        _agents.refresh();
        _contacts.refresh();
        _circle.refreshOpenJobs();
      });
    } else {
      _api.setAuthToken(null);
      _api.setUserId(null);
      _pusher.setAuthToken(null);
      _moneyAlerts.stop();
      _circle.reset();
      _wallet.reset();
      _activity.clear();
    }
  }

  @override
  void dispose() {
    if (widget.homeOverride != null) {
      super.dispose();
      return;
    }
    WidgetsBinding.instance.removeObserver(this);
    _authDebounce?.cancel();
    _auth.removeListener(_onAuth);
    if (_ownsServices) {
      _auth.dispose();
      _fx.dispose();
      _theme.dispose();
      _api.dispose();
      _pusher.dispose();
      _appLock.dispose();
      _features.dispose();
      _appLinks.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.homeOverride case final home?) {
      return MaterialApp(
        title: 'evabob',
        debugShowCheckedModeBanner: false,
        theme: EvabobTheme.light(),
        home: home,
      );
    }
    return MultiProvider(
      providers: [
        Provider<ApiClient>.value(value: _api),
        ChangeNotifierProvider<FxService>.value(value: _fx),
        ChangeNotifierProvider<EvabobAuth>.value(value: _auth),
        ChangeNotifierProvider<ChatService>.value(value: _chat),
        Provider<PusherService>.value(value: _pusher),
        ChangeNotifierProvider<WalletService>.value(value: _wallet),
        ChangeNotifierProvider<CircleWalletService>.value(value: _circle),
        ChangeNotifierProvider<ActivityService>.value(value: _activity),
        ChangeNotifierProvider<AgentService>.value(value: _agents),
        ChangeNotifierProvider<ContactsService>.value(value: _contacts),
        ChangeNotifierProvider<ThemeController>.value(value: _theme),
        ChangeNotifierProvider<SectionNotify>.value(value: _notify),
        ChangeNotifierProvider<AppLockService>.value(value: _appLock),
        ChangeNotifierProvider<AppFeatures>.value(value: _features),
        ChangeNotifierProvider<AppLinkService>.value(value: _appLinks),
      ],
      child: Consumer<ThemeController>(
        builder: (context, theme, _) {
          return MaterialApp(
            title: 'evabob',
            debugShowCheckedModeBanner: false,
            theme: EvabobTheme.light(),
            darkTheme: EvabobTheme.dark(),
            themeMode: theme.mode,
            builder: (context, child) {
              // Headless Dynamic bridge: keep the WebView alive for email OTP
              // message transport, but never expand it into Dynamic's built-in
              // "collect phone" onboarding UI (phone is optional in our Profile).
              final overlay = _auth.dynamicOverlay;
              final body = overlay == null
                  ? (child ?? const SizedBox.shrink())
                  : Stack(
                      fit: StackFit.expand,
                      children: [
                        child ?? const SizedBox.shrink(),
                        Positioned(
                          left: 0,
                          top: 0,
                          width: 1,
                          height: 1,
                          child: IgnorePointer(child: overlay),
                        ),
                      ],
                    );

              // Honour the system font size, up to a point.
              //
              // Nothing clamped it before, and a good deal of this app is laid
              // out at fixed heights — the nav bar, the filter row, the chat
              // receipt bubbles — so at the largest Android setting those
              // clipped rather than grew. 1.3 is where they stop coping.
              // Someone who needs more than that is better served by the
              // system magnifier than by a screen that has eaten its own
              // labels.
              return MediaQuery.withClampedTextScaling(
                minScaleFactor: 1.0,
                maxScaleFactor: 2.0,
                child: Builder(builder: (_) => body),
              );
            },
            home: Consumer2<EvabobAuth, AppLockService>(
              builder: (context, auth, lock, _) {
                if (!auth.isReady || !lock.ready) {
                  return const Scaffold(
                    body: Center(
                      child: CircularProgressIndicator(
                        color: EvabobColors.blue,
                      ),
                    ),
                  );
                }
                if (!auth.isSignedIn) return const LoginScreen();
                // First-layer app lock (local PIN / biometrics) before shell.
                if (lock.needsUnlock) {
                  return const AppLockScreen();
                }
                if (auth.isDemoMode) return const AppShell();
                return const PostSignupOnboarding();
              },
            ),
          );
        },
      ),
    );
  }
}
