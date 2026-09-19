import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:provider/provider.dart';

import '../../core/chat/chat_service.dart';
import '../../core/notify/section_notify.dart';
import '../../core/config/app_features.dart';
import '../../core/navigation/app_link_service.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/widgets/glass.dart';
// SectionNotify used for tab badges
import '../activity/activity_screen.dart';
import '../agents/agents_screen.dart';
import '../assets/assets_screen.dart';
import '../bridge/bridge_screen.dart';
import '../chat/chat_list_screen.dart';
import '../exchange/exchange_screen.dart';
import '../gateway/gateway_screen.dart';
import '../held/held_payment_screen.dart';
import '../held/operator_reviews_screen.dart';
import '../groups/groups_screen.dart';
import '../hold_links/hold_link_pay_screen.dart';
import '../home/home_screen.dart';
import '../profile/profile_screen.dart';
import '../request/request_screen.dart';
import '../request/payment_link_screen.dart';
import '../notifications/notifications_screen.dart';
import '../send/send_screen.dart';
import '../wallet/circle_onboard_sheet.dart';
import '../agent_tasks/agent_tasks_screen.dart';
import '../paywalls/paywalls_screen.dart';

class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _tab = 0;
  String? _overlay;
  bool _walletBootstrapStarted = false;
  String? _bootstrappedForUser;

  bool _enabled(String route, AppFeatures features) {
    switch (route) {
      case 'send':
        return features.directSend;
      case 'request':
        return features.requests;
      case 'fund':
      case 'gateway':
      case 'topup':
        return features.gateway;
      case 'exchange':
      case 'buy':
        return features.conversion;
      case 'withdraw':
      case 'bridge':
        return features.bridge;
      case 'agents':
        return features.agentWallets;
      default:
        return true;
    }
  }

  void _open(String route) {
    final features = context.read<AppFeatures>();
    if (!_enabled(route, features)) return;
    setState(() => _overlay = route);
  }

  void _close() => setState(() => _overlay = null);

  bool get _showNav => _overlay == null;

  void _consumeAppLink(AppLinkService links) {
    final uri = links.take();
    if (uri == null || !mounted) return;
    final parts = <String>[
      if (uri.host.isNotEmpty) uri.host,
      ...uri.pathSegments,
    ];
    // "Pay @name" from a card: Send, with who to pay already filled in.
    if (parts.length >= 2 && parts.first.toLowerCase() == 'send') {
      if (!_enabled('send', context.read<AppFeatures>())) return;
      setState(() => _overlay = 'send:${Uri.decodeComponent(parts[1])}');
      return;
    }
    if (parts.length >= 2 && parts.first.toLowerCase() == 'pay') {
      setState(() => _overlay = 'pay:${parts[1]}');
      return;
    }
    // A tapped notification about a held payment opens that payment.
    if (parts.length >= 2 && parts.first.toLowerCase() == 'held') {
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => HeldPaymentScreen(transferId: parts[1]),
        ),
      );
      return;
    }
    // A money circle or collection (from an invite or a shared link).
    if (parts.length >= 2 && parts.first.toLowerCase() == 'group') {
      openGroup(context, parts[1]);
      return;
    }
    // An agent: from an approval or pause notification, or its money.
    if (parts.isNotEmpty && parts.first.toLowerCase() == 'agents') {
      if (!_enabled('agents', context.read<AppFeatures>())) return;
      setState(
          () => _overlay = parts.length >= 2 ? 'agents:${parts[1]}' : 'agents');
      return;
    }
    // A task an agent will pay a person for.
    if (parts.length >= 2 && parts.first.toLowerCase() == 'task') {
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => AgentTaskScreen(taskId: parts[1]),
        ),
      );
      return;
    }
    // Something the person sells to software: a sale or a booking.
    if (parts.isNotEmpty && parts.first.toLowerCase() == 'paywall') {
      Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => const PaywallsScreen()),
      );
      return;
    }
    // A seller's hold link: pay into a hold until the order arrives.
    if (parts.length >= 2 && parts.first.toLowerCase() == 'hold') {
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => HoldLinkPayScreen(linkId: parts[1]),
        ),
      );
      return;
    }
    if (parts.isNotEmpty && parts.first.toLowerCase() == 'reviews') {
      Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => const OperatorReviewsScreen()),
      );
      return;
    }
    if (parts.length >= 2 && parts.first.toLowerCase() == 'review') {
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => OperatorReviewDetailScreen(transferId: parts[1]),
        ),
      );
      return;
    }
    if (parts.isNotEmpty && parts.first.toLowerCase() == 'activity') {
      setState(() => _overlay = 'activity');
      return;
    }
    if (parts.isNotEmpty && parts.first.toLowerCase() == 'claim') {
      final transferId = uri.queryParameters['transferId'] ??
          uri.queryParameters['token'] ??
          (parts.length >= 2 ? parts[1] : null);
      if (transferId != null && transferId.isNotEmpty) {
        setState(() => _overlay = 'claim:$transferId');
      }
    }
  }

  @override
  void initState() {
    super.initState();
    // After login, create/link spendable wallet automatically (PIN if needed).
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrapWallet());
  }

  Future<void> _bootstrapWallet() async {
    if (!mounted) return;
    final circle = context.read<CircleWalletService>();
    final uid = circle.hasSession || circle.ready ? (circle.address ?? '') : '';
    // Re-run bootstrap when wallet was reset for a new account.
    if (_walletBootstrapStarted &&
        circle.ready &&
        circle.address != null &&
        _bootstrappedForUser == circle.address) {
      await circle.refreshSessionOnly();
      return;
    }
    if (_walletBootstrapStarted && circle.ready && circle.address != null) {
      await circle.refreshSessionOnly();
      _bootstrappedForUser = circle.address;
      return;
    }
    _walletBootstrapStarted = true;
    await openCircleWalletOnboarding(context, silent: true);
    if (mounted) {
      _bootstrappedForUser = circle.address ?? uid;
    }
  }

  @override
  Widget build(BuildContext context) {
    final links = context.watch<AppLinkService>();
    if (links.pending != null) {
      WidgetsBinding.instance
          .addPostFrameCallback((_) => _consumeAppLink(links));
    }
    return Scaffold(
      extendBody: true,
      backgroundColor: EvabobColors.pageBg,
      body: ColoredBox(
        color: EvabobColors.pageBg,
        child: AnimatedSwitcher(
          duration: Motion.base,
          switchInCurve: Motion.smooth,
          child: _buildBody(),
        ),
      ),
      bottomNavigationBar: _showNav ? _bottomNav() : null,
    );
  }

  Widget _buildBody() {
    final overlay = _overlay;
    if (overlay != null && overlay.startsWith('pay:')) {
      return PaymentLinkScreen(
        key: ValueKey(overlay),
        requestId: overlay.substring(4),
        onBack: _close,
      );
    }
    if (overlay != null && overlay.startsWith('send:')) {
      return SendScreen(
        key: ValueKey(overlay),
        onBack: _close,
        initialTo: overlay.substring(5),
      );
    }
    if (overlay != null && overlay.startsWith('agents:')) {
      return AgentsScreen(
        key: ValueKey(overlay),
        onBack: _close,
        initialAgentId: overlay.substring(7),
      );
    }
    if (overlay != null && overlay.startsWith('claim:')) {
      return ClaimLinkScreen(
        key: ValueKey(overlay),
        transferId: overlay.substring(6),
        onBack: _close,
      );
    }
    switch (_overlay) {
      case 'send':
        return SendScreen(key: const ValueKey('send'), onBack: _close);
      // Fund / Top-up / unified balance (App Kit deposit under the hood).
      // 'fund' used to open a Deposit tab that only displayed a receive
      // address without crediting the unified balance. Top-up is the action
      // that actually moves USDC into Gateway; the address lives on Receive.
      case 'fund':
        return GatewayScreen(
          key: const ValueKey('fund'),
          onBack: _close,
          mode: GatewayMode.topUp,
        );
      case 'receive':
        return AssetsScreen(
          key: const ValueKey('receive'),
          onBack: _close,
          onSend: () => _open('send'),
          onReceive: () => _open('receive'),
          onBridge: () => _open('bridge'),
        );
      case 'gateway':
      case 'topup':
        return GatewayScreen(
          key: const ValueKey('gateway'),
          onBack: _close,
          mode: GatewayMode.topUp,
        );
      case 'exchange':
      case 'buy':
        return ExchangeScreen(
          key: const ValueKey('buy'),
          onBack: _close,
          title: 'Convert',
        );
      case 'activity':
        return ActivityScreen(
          key: const ValueKey('act'),
          onBack: _close,
          onSend: () => _open('send'),
          onTopUp: () => _open('fund'),
        );
      case 'notifications':
        return NotificationsScreen(
          key: const ValueKey('notifications'),
          onBack: _close,
        );
      case 'profile':
        return ProfileScreen(
          key: const ValueKey('profile'),
          onBack: _close,
          showBack: true,
        );
      case 'withdraw':
      case 'bridge':
        return BridgeScreen(key: const ValueKey('bridge'), onBack: _close);
      case 'agents':
        return AgentsScreen(key: const ValueKey('agents'), onBack: _close);
      case 'request':
        return RequestScreen(key: const ValueKey('request'), onBack: _close);
      case 'assets':
        return AssetsScreen(
          key: const ValueKey('assets'),
          onBack: _close,
          onSend: () => _open('send'),
          onReceive: () => _open('receive'),
          onBridge: () => _open('bridge'),
        );
    }

    switch (_tab) {
      case 1:
        return const ChatListScreen(key: ValueKey('chat'));
      case 3:
        return ActivityScreen(
          key: const ValueKey('act-tab'),
          onSend: () => _open('send'),
          onTopUp: () => _open('fund'),
        );
      case 4:
        return AssetsScreen(
          key: const ValueKey('assets-tab'),
          onSend: () => _open('send'),
          onReceive: () => _open('receive'),
          onBridge: () => _open('bridge'),
        );
      default:
        return HomeScreen(
          key: const ValueKey('home'),
          onSend: () => _open('send'),
          onFund: () => _open('fund'),
          onExchange: () => _open('buy'),
          onActivity: () => _open('activity'),
          onNotifications: () => _open('notifications'),
          onProfile: () => _open('profile'),
          onBridge: () => _open('bridge'),
          onAgents: () => _open('agents'),
          onGateway: () => _open('topup'),
          onRequest: () => _open('request'),
          onChatList: () => setState(() => _tab = 1),
        );
    }
  }

  Widget _bottomNav() {
    final bottom = MediaQuery.paddingOf(context).bottom;
    final canSend = context.watch<AppFeatures>().directSend;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, bottom > 0 ? bottom * .15 : 5),
      child: Container(
        height: 87,
        padding: const EdgeInsets.fromLTRB(8, 10, 8, 10),
        decoration: const BoxDecoration(
          color: EvabobColors.white,
          borderRadius: BorderRadius.all(Radius.circular(16)),
          boxShadow: Shadows.card,
        ),
        child: Row(
          children: [
            _navItem(0, 'home', 'Home'),
            _navItem(1, 'chat', 'Chat'),
            Expanded(
              child: canSend
                  ? Semantics(
                      button: true,
                      label: 'Send money',
                      child: PressScale(
                        onTap: () => _open('send'),
                        scale: Motion.pressScale,
                        child: Transform.translate(
                          offset: const Offset(0, -16),
                          child: Container(
                            width: 56,
                            height: 56,
                            decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              color: EvabobColors.blue,
                              boxShadow: Shadows.button,
                            ),
                            child: const Icon(
                              Icons.arrow_upward_rounded,
                              color: EvabobColors.white,
                              size: 24,
                            ),
                          ),
                        ),
                      ),
                    )
                  : const SizedBox.shrink(),
            ),
            _navItem(3, 'activity', 'Activity'),
            _navItem(4, 'wallet', 'Wallet'),
          ],
        ),
      ),
    );
  }

  Widget _navItem(int index, String asset, String label) {
    final active = _tab == index && _overlay == null;
    final notify = context.watch<SectionNotify>();
    final badge = notify.countForTab(index);
    final color = active ? EvabobColors.blue : EvabobColors.inkMuted;
    return Expanded(
      child: Semantics(
        selected: active,
        button: true,
        label: label,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () {
            setState(() {
              _overlay = null;
              _tab = index;
            });
            if (index == 1) {
              notify.clear('chat');
              // Fresh names, pictures and last messages each time Chat opens.
              context.read<ChatService>().refreshThreads();
            }
            if (index == 3) notify.clear('activity');
            if (index == 4) notify.clear('assets');
          },
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.topCenter,
            children: [
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  SvgPicture.asset(
                    'assets/icons/$asset.svg',
                    width: 22,
                    height: 22,
                    colorFilter: ColorFilter.mode(color, BlendMode.srcIn),
                  ),
                  const SizedBox(height: 4),
                  Text(label, style: Type.tab.copyWith(color: color)),
                ],
              ),
              if (badge > 0)
                Positioned(
                  right: 5,
                  top: 0,
                  child: Container(
                    constraints:
                        const BoxConstraints(minWidth: 16, minHeight: 16),
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(
                      color: EvabobColors.alert,
                      shape: BoxShape.circle,
                    ),
                    child: Text(
                      badge > 9 ? '9+' : '$badge',
                      style: Type.label.copyWith(
                        color: EvabobColors.white,
                        fontSize: 9,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
