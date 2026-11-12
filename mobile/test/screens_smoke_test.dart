// Every main screen, drawn at a small phone's size with the real fonts.
//
// Two jobs. A layout that overflows fails the test — text sizes are shared
// tokens, so one change can push a row past its edge on a screen nobody
// opened. And with SCREENSHOT_DIR set, each screen is saved as a PNG so a
// design change can be looked at without building the app:
//
//   SCREENSHOT_DIR=C:\tmp\shots flutter test test/screens_smoke_test.dart
//
// The services point at an address nothing listens on, so screens show their
// empty and loading states.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:evabob_mobile/core/activity/activity_service.dart';
import 'package:evabob_mobile/core/agents/agent_service.dart';
import 'package:evabob_mobile/core/api/api_client.dart';
import 'package:evabob_mobile/core/auth/evabob_auth.dart';
import 'package:evabob_mobile/core/chat/chat_service.dart';
import 'package:evabob_mobile/core/chat/pusher_service.dart';
import 'package:evabob_mobile/core/config/app_features.dart';
import 'package:evabob_mobile/core/notifications/money_alerts.dart';
import 'package:evabob_mobile/core/contacts/contacts_service.dart';
import 'package:evabob_mobile/core/fx/fx_service.dart';
import 'package:evabob_mobile/core/notify/section_notify.dart';
import 'package:evabob_mobile/core/platform/web_phone_frame.dart';
import 'package:evabob_mobile/core/security/app_lock_service.dart';
import 'package:evabob_mobile/core/theme/evabob_theme.dart';
import 'package:evabob_mobile/core/theme/theme_controller.dart';
import 'package:evabob_mobile/core/wallet/circle_wallet_service.dart';
import 'package:evabob_mobile/core/wallet/wallet_service.dart';
import 'package:evabob_mobile/features/activity/activity_screen.dart';
import 'package:evabob_mobile/features/agent_tasks/agent_tasks_screen.dart';
import 'package:evabob_mobile/features/agents/agents_screen.dart';
import 'package:evabob_mobile/features/assets/assets_screen.dart';
import 'package:evabob_mobile/features/bridge/bridge_screen.dart';
import 'package:evabob_mobile/features/chat/chat_list_screen.dart';
import 'package:evabob_mobile/features/exchange/exchange_screen.dart';
import 'package:evabob_mobile/features/gateway/gateway_screen.dart';
import 'package:evabob_mobile/features/groups/groups_screen.dart';
import 'package:evabob_mobile/features/hold_links/hold_links_screen.dart';
import 'package:evabob_mobile/features/home/home_menu.dart';
import 'package:evabob_mobile/features/home/home_screen.dart';
import 'package:evabob_mobile/features/market/market_checks_screen.dart';
import 'package:evabob_mobile/features/market/market_mine_screen.dart';
import 'package:evabob_mobile/features/market/market_post_form.dart';
import 'package:evabob_mobile/features/market/market_screen.dart';
import 'package:evabob_mobile/features/notifications/notifications_screen.dart';
import 'package:evabob_mobile/features/paywalls/paywalls_screen.dart';
import 'package:evabob_mobile/features/profile/profile_screen.dart';
import 'package:evabob_mobile/features/request/request_history_screen.dart';
import 'package:evabob_mobile/features/request/request_screen.dart';
import 'package:evabob_mobile/features/send/send_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _shotDir = Platform.environment['SCREENSHOT_DIR'];

Future<void> _loadFonts() async {
  final numans = FontLoader('Numans')
    ..addFont(rootBundle.load('assets/Numans/Numans-Regular.ttf'));
  await numans.load();
  // The icon font ships with the SDK, not the app.
  final flutterRoot = Platform.environment['FLUTTER_ROOT'];
  if (flutterRoot == null) return;
  final icons = File(
      '$flutterRoot/bin/cache/artifacts/material_fonts/materialicons-regular.otf');
  if (!icons.existsSync()) return;
  final bytes = icons.readAsBytesSync();
  final loader = FontLoader('MaterialIcons')
    ..addFont(Future.value(ByteData.view(bytes.buffer)));
  await loader.load();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({});
    await _loadFonts();
  });

  final boundary = GlobalKey();

  Widget app(Widget screen) {
    final api = ApiClient(baseUrl: 'http://127.0.0.1:1');
    final fx = FxService();
    final auth = EvabobAuth(api: api);
    final notify = SectionNotify();
    final features = AppFeatures(api)
      ..requests = true
      ..gateway = true
      ..conversion = true
      ..agentWallets = true
      ..directSend = true
      ..bridgeRoutes = const ['Arc_Testnet:Base_Sepolia'];
    return MultiProvider(
      providers: [
        Provider<ApiClient>.value(value: api),
        ChangeNotifierProvider<FxService>.value(value: fx),
        ChangeNotifierProvider<EvabobAuth>.value(value: auth),
        ChangeNotifierProvider<ChatService>.value(
            value: ChatService(fx, api, notify: notify)),
        ChangeNotifierProvider<WalletService>.value(
            value: WalletService(api, auth)),
        ChangeNotifierProvider<CircleWalletService>.value(
            value: CircleWalletService(api, auth)),
        ChangeNotifierProvider<ActivityService>.value(
            value: ActivityService(api, fx)),
        ChangeNotifierProvider<AgentService>.value(value: AgentService(api)),
        ChangeNotifierProvider<ContactsService>.value(
            value: ContactsService(api)),
        ChangeNotifierProvider<ThemeController>.value(value: ThemeController()),
        ChangeNotifierProvider<SectionNotify>.value(value: notify),
        ChangeNotifierProvider<AppFeatures>.value(value: features),
        Provider<MoneyAlerts>.value(value: MoneyAlerts(PusherService())),
        ChangeNotifierProvider<AppLockService>.value(value: AppLockService()),
      ],
      child: RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: EvabobTheme.light(),
          // Tab screens sit inside the shell's Scaffold in the app.
          home: Material(color: const Color(0xFFF0FAFF), child: screen),
        ),
      ),
    );
  }

  Future<void> shoot(WidgetTester tester, String name) async {
    final dir = _shotDir;
    if (dir == null || dir.isEmpty) return;
    await tester.runAsync(() async {
      final render =
          boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await render.toImage(pixelRatio: 2);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      Directory(dir).createSync(recursive: true);
      File('$dir/$name.png').writeAsBytesSync(data!.buffer.asUint8List());
    });
  }

  void noop() {}

  final screens = <String, Widget Function()>{
    'home': () => HomeScreen(
          onSend: noop,
          onFund: noop,
          onExchange: noop,
          onActivity: noop,
          onProfile: noop,
          onBridge: noop,
          onAgents: noop,
          onChatList: noop,
        ),
    'wallet': () => AssetsScreen(onSend: noop, onReceive: noop, onBridge: noop),
    'get_paid': () => const RequestScreen(),
    'requests': () => const RequestHistoryScreen(),
    'circles': () => const GroupsScreen(),
    'sell_links': () => const HoldLinksScreen(),
    'paywalls': () => const PaywallsScreen(),
    'agent_tasks': () => const AgentTasksScreen(),
    'agent_wallets': () => const AgentsScreen(),
    'convert': () => const ExchangeScreen(),
    'move_money': () => const BridgeScreen(),
    'chat_list': () => const ChatListScreen(),
    'profile': () => const ProfileScreen(),
    'activity': () => const ActivityScreen(),
    'send': () => const SendScreen(),
    'gateway': () => const GatewayScreen(),
    'notifications': () => NotificationsScreen(onBack: noop),
    'market': () => const MarketScreen(),
    'market_post_form': () => const MarketPostForm(want: true),
    'market_mine': () => const MarketMineScreen(),
    'market_checks': () => const MarketChecksScreen(),
  };

  for (final entry in screens.entries) {
    testWidgets('${entry.key} lays out on a small phone', (tester) async {
      tester.view.physicalSize = const Size(360, 780);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(app(entry.value()));
      // Let first frames, entrance motion and failed loads settle. Not
      // pumpAndSettle: loading spinners never settle.
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 250));
      }
      await shoot(tester, entry.key);
      expect(tester.takeException(), isNull, reason: entry.key);
      // Unmount so timers the screen started are cancelled before the test
      // ends.
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
    });
  }

  testWidgets('the website layout: a sidebar and a wide market on a laptop',
      (tester) async {
    tester.view.physicalSize = const Size(1366, 768);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(app(Builder(
      builder: (context) => WebPhoneFrame(
        signedIn: true,
        child: Navigator(
          onGenerateRoute: (_) => MaterialPageRoute<void>(
            builder: (_) => const Material(
              color: Color(0xFFF0FAFF),
              child: MarketScreen(),
            ),
          ),
        ),
      ),
    )));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 250));
    }
    await shoot(tester, 'website_market');
    expect(tester.takeException(), isNull);
    expect(find.text('Send money'), findsOneWidget);
    // The screen is given the column's width, not the window's.
    expect(tester.getSize(find.byType(MarketScreen)).width, 880);
    // A sidebar destination is passed to the shell.
    await tester.tap(find.text('Wallet'));
    expect(ShellNav.current.value, 'tab:4');
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a phone-sized browser window gets no sidebar', (tester) async {
    tester.view.physicalSize = const Size(390, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const MaterialApp(
      home: WebPhoneFrame(signedIn: true, child: Text('app')),
    ));
    expect(find.text('Send money'), findsNothing);
    expect(find.text('app'), findsOneWidget);
  });

  testWidgets('home menu lays out on a small phone', (tester) async {
    tester.view.physicalSize = const Size(360, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    late BuildContext ctx;
    await tester.pumpWidget(app(Builder(builder: (c) {
      ctx = c;
      return const Scaffold();
    })));
    showHomeMenu(ctx);
    await tester.pumpAndSettle();
    await shoot(tester, 'home_menu');
    expect(tester.takeException(), isNull);
  });
}
