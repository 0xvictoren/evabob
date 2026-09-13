import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/auth/evabob_auth.dart';
import '../../core/chat/chat_models.dart';
import '../../core/chat/chat_service.dart';
import '../../core/fx/fx_service.dart';
import '../../core/config/app_features.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/address_scan_sheet.dart';
import '../../core/widgets/bundle_avatar.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';
import '../activity/incomplete_jobs_banner.dart';
import '../activity/receipt_sheet.dart';
import '../chat/chat_thread_screen.dart';
import 'action_row.dart';
import 'home_menu.dart';
import 'income_card.dart';

/// Figma Home frame (`2:2`) with the live wallet and activity services wired in.
class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.onSend,
    required this.onFund,
    required this.onExchange,
    required this.onActivity,
    required this.onProfile,
    required this.onBridge,
    required this.onAgents,
    required this.onChatList,
    this.onGateway,
    this.onRequest,
  });

  final VoidCallback onSend;
  final VoidCallback onFund;
  final VoidCallback onExchange;
  final VoidCallback onActivity;
  final VoidCallback onProfile;
  final VoidCallback onBridge;
  final VoidCallback onAgents;
  final VoidCallback onChatList;
  final VoidCallback? onGateway;
  final VoidCallback? onRequest;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final circle = context.read<CircleWalletService>();
      await Future.wait([
        context.read<WalletService>().refreshBalances(
              addressOverride: circle.address,
              silent: true,
            ),
        context.read<ActivityService>().refresh(),
        context.read<ChatService>().refreshThreads(),
        circle.refreshOpenJobs(),
      ]);
    });
  }

  Future<void> _refresh() async {
    final circle = context.read<CircleWalletService>();
    await Future.wait([
      context.read<WalletService>().refreshBalances(
            addressOverride: circle.address,
            force: true,
          ),
      context.read<ActivityService>().refresh(),
      context.read<ChatService>().refreshThreads(),
      circle.refreshOpenJobs(),
    ]);
  }

  Future<void> _openMenu() async {
    final choice = await showHomeMenu(context);
    if (!mounted || choice == null) return;
    switch (choice) {
      case HomeMenuAction.request:
        (widget.onRequest ?? widget.onSend)();
      case HomeMenuAction.convert:
        widget.onExchange();
      case HomeMenuAction.ga:
        (widget.onGateway ?? widget.onFund)();
      case HomeMenuAction.moveMoney:
        widget.onBridge();
      case HomeMenuAction.agent:
        widget.onAgents();
      case HomeMenuAction.profile:
        widget.onProfile();
    }
  }

  void _openThread(ChatThread thread) {
    Navigator.of(context).push(
      SpringPageRoute(page: ChatThreadScreen(thread: thread)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final wallet = context.watch<WalletService>();
    final activity = context.watch<ActivityService>();
    final circle = context.watch<CircleWalletService>();
    final features = context.watch<AppFeatures>();

    return RefreshIndicator(
      color: EvabobColors.blue,
      onRefresh: _refresh,
      child: ListView(
        padding: const EdgeInsets.only(bottom: 124),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          _Hero(
            wallet: wallet,
            onMore: _openMenu,
            onNotifications: widget.onActivity,
            onProfile: widget.onProfile,
            onSend: widget.onSend,
            onScan: () => AddressScanSheet.open(context),
            onRequest: widget.onRequest ?? widget.onSend,
            showSend: features.directSend,
            showRequest: features.requests,
          ),
          Transform.translate(
            offset: const Offset(0, -55),
            child: Container(
              decoration: const BoxDecoration(
                color: EvabobColors.pageBg,
                borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
              ),
              padding: const EdgeInsets.fromLTRB(20, 32, 20, 24),
              child: Column(
                children: [
                  Row(
                    children: [
                      Text('Your money', style: Type.title),
                      const Spacer(),
                      _TextLink(label: 'View all ›', onTap: widget.onBridge),
                    ],
                  ),
                  const SizedBox(height: 8),
                  _MoneyCard(wallet: wallet, jobs: circle.openJobs),
                  const IncompleteJobsBanner(),
                  const SizedBox(height: 24),
                  IncomeCard(activity: activity),
                  const SizedBox(height: 24),
                  _RecentActivity(
                    activity: activity,
                    onSeeAll: widget.onActivity,
                    onOpen: (entry) => ReceiptSheet.open(context, entry),
                  ),
                  _ConversationShortcut(
                    chat: context.watch<ChatService>(),
                    onOpen: _openThread,
                    onSeeAll: widget.onChatList,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({
    required this.wallet,
    required this.onMore,
    required this.onNotifications,
    required this.onProfile,
    required this.onSend,
    required this.onScan,
    required this.onRequest,
    required this.showSend,
    required this.showRequest,
  });

  final WalletService wallet;
  final VoidCallback onMore;
  final VoidCallback onNotifications;
  final VoidCallback onProfile;
  final VoidCallback onSend;
  final VoidCallback onScan;
  final VoidCallback onRequest;
  final bool showSend;
  final bool showRequest;

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<EvabobAuth>();
    final fx = context.watch<FxService>();
    final dollars = wallet.usdcWallet;
    final local = formatNgn(fx.usdcToNgn(dollars));
    final amount = formatMoney(dollars);
    final dot = amount.lastIndexOf('.');
    final whole = dot < 0 ? amount : amount.substring(0, dot);
    final decimals = dot < 0 ? '' : amount.substring(dot);
    final displayName = auth.user?.displayName ?? 'Your account';
    final handle = auth.user?.handleOrFallback ?? 'you';
    final top = MediaQuery.paddingOf(context).top;

    return Container(
      height: 424,
      padding: EdgeInsets.fromLTRB(20, top + 18, 20, 86),
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.bottomLeft,
          end: Alignment.topRight,
          colors: [Color(0xFF06B3F9), EvabobColors.blue, Color(0xFF00B5FF)],
        ),
      ),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            right: -118,
            top: -118,
            child: IgnorePointer(
              child: Container(
                width: 260,
                height: 260,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(
                      color: const Color(0xFF22C3F0).withValues(alpha: .55),
                      blurRadius: 70,
                      spreadRadius: 20,
                    ),
                  ],
                ),
              ),
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  PressScale(
                    onTap: onProfile,
                    child: const UserAvatar(size: 44),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          displayName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Type.body.copyWith(color: EvabobColors.white),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '@$handle',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Type.label.copyWith(
                            color: EvabobColors.lightDark,
                          ),
                        ),
                      ],
                    ),
                  ),
                  _HeroIcon(
                      icon: Icons.more_horiz, label: 'More', onTap: onMore),
                  const SizedBox(width: 8),
                  _HeroIcon(
                    icon: Icons.notifications_none_rounded,
                    label: 'Notifications',
                    onTap: onNotifications,
                  ),
                ],
              ),
              const SizedBox(height: 36),
              Text(
                'Spendable balance',
                style: Type.label.copyWith(color: EvabobColors.lightDark),
              ),
              CountUp(
                dollars,
                builder: (_, __) => FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text.rich(
                    TextSpan(
                      style: Type.hero.copyWith(color: EvabobColors.white),
                      children: [
                        TextSpan(text: whole),
                        TextSpan(
                          text: decimals,
                          style:
                              Type.hero.copyWith(color: EvabobColors.lightDark),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              Text(
                '≈ $local in your pocket',
                style: Type.body.copyWith(color: EvabobColors.lightDark),
              ),
              const Spacer(),
              HomeActionRow(
                onSend: onSend,
                onScan: onScan,
                onRequest: onRequest,
                showSend: showSend,
                showRequest: showRequest,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _HeroIcon extends StatelessWidget {
  const _HeroIcon(
      {required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      child: PressScale(
        onTap: onTap,
        child: Container(
          width: 36,
          height: 36,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: EvabobColors.white.withValues(alpha: .18),
          ),
          child: Icon(icon, color: EvabobColors.white, size: 20),
        ),
      ),
    );
  }
}

class _MoneyCard extends StatelessWidget {
  const _MoneyCard({required this.wallet, required this.jobs});

  final WalletService wallet;
  final List<Map<String, dynamic>> jobs;

  @override
  Widget build(BuildContext context) {
    var held = 0.0;
    for (final job in jobs) {
      held += (job['amountUsdc'] as num?)?.toDouble() ?? 0;
    }
    final amount = held > 0 ? held : wallet.gatewayPendingUsdc;
    final waiting = jobs.isNotEmpty || wallet.gatewayPendingUsdc > 0;

    return Container(
      height: 88,
      padding: const EdgeInsets.all(16),
      decoration: const BoxDecoration(
        color: EvabobColors.white,
        borderRadius: BorderRadius.all(Radius.circular(12)),
        boxShadow: Shadows.card,
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: EvabobColors.pageBg,
              shape: BoxShape.circle,
            ),
            child: Text(
              waiting ? 'AM' : '✓',
              style: Type.body.copyWith(color: EvabobColors.blue),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(waiting ? 'On hold' : 'All clear', style: Type.body),
                const SizedBox(height: 2),
                Text(
                  waiting
                      ? 'Waiting for a payment to finish'
                      : 'No payments are waiting',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Type.label.copyWith(color: EvabobColors.inkMuted),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(formatMoney(amount), style: Type.amount),
        ],
      ),
    );
  }
}

class _RecentActivity extends StatelessWidget {
  const _RecentActivity({
    required this.activity,
    required this.onSeeAll,
    required this.onOpen,
  });

  final ActivityService activity;
  final VoidCallback onSeeAll;
  final ValueChanged<ActivityEntry> onOpen;

  @override
  Widget build(BuildContext context) {
    final items = activity.items.take(4).toList();
    return Column(
      children: [
        Row(
          children: [
            Text('Recent activity', style: Type.title),
            const Spacer(),
            _TextLink(label: 'View all ›', onTap: onSeeAll),
          ],
        ),
        const SizedBox(height: 8),
        Container(
          decoration: const BoxDecoration(
            color: EvabobColors.white,
            borderRadius: BorderRadius.all(Radius.circular(12)),
            boxShadow: Shadows.card,
          ),
          child: items.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    activity.loading
                        ? 'Loading…'
                        : activity.error != null
                            ? 'Could not load your activity.'
                            : 'Nothing yet.',
                    style: Type.body.copyWith(color: EvabobColors.inkMuted),
                  ),
                )
              : Column(
                  children: [
                    for (var i = 0; i < items.length; i++) ...[
                      _ActivityRow(
                          entry: items[i], onTap: () => onOpen(items[i])),
                      if (i != items.length - 1)
                        const Padding(
                          padding: EdgeInsets.only(left: 68),
                          child: Divider(),
                        ),
                    ],
                  ],
                ),
        ),
        const SizedBox(height: 24),
      ],
    );
  }
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow({required this.entry, required this.onTap});

  final ActivityEntry entry;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final token = entry.displayToken;
    final amount = formatMoney(entry.displayAmount, token);
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        height: 72,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  color: EvabobColors.pageBg,
                  shape: BoxShape.circle,
                ),
                child: Text(
                  _initials(entry.title),
                  style: Type.body.copyWith(color: EvabobColors.blue),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      entry.title.isEmpty ? kindLabel(entry.kind) : entry.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Type.body,
                    ),
                    Text(
                      kindLabel(entry.kind),
                      style: Type.label.copyWith(color: EvabobColors.inkMuted),
                    ),
                  ],
                ),
              ),
              Text(
                '${entry.positive ? '+' : ''}$amount',
                style: Type.amount.copyWith(
                  color:
                      entry.positive ? EvabobColors.moneyIn : EvabobColors.ink,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  static String _initials(String value) {
    final parts = value.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty || parts.first.isEmpty) return 'EB';
    return parts.take(2).map((part) => part[0].toUpperCase()).join();
  }
}

class _ConversationShortcut extends StatelessWidget {
  const _ConversationShortcut({
    required this.chat,
    required this.onOpen,
    required this.onSeeAll,
  });

  final ChatService chat;
  final ValueChanged<ChatThread> onOpen;
  final VoidCallback onSeeAll;

  @override
  Widget build(BuildContext context) {
    if (chat.threads.isEmpty) return const SizedBox.shrink();
    final thread = chat.threads.first;
    return Column(
      children: [
        Row(
          children: [
            Text('Messages', style: Type.title),
            const Spacer(),
            _TextLink(label: 'View all ›', onTap: onSeeAll),
          ],
        ),
        const SizedBox(height: 8),
        InkWell(
          onTap: () => onOpen(thread),
          borderRadius: BorderRadius.circular(12),
          child: Container(
            height: 72,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: const BoxDecoration(
              color: EvabobColors.white,
              borderRadius: BorderRadius.all(Radius.circular(12)),
              boxShadow: Shadows.card,
            ),
            child: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  alignment: Alignment.center,
                  decoration: const BoxDecoration(
                    color: EvabobColors.pageBg,
                    shape: BoxShape.circle,
                  ),
                  child: Text('EB',
                      style: Type.body.copyWith(color: EvabobColors.blue)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    thread.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Type.body,
                  ),
                ),
                const Icon(Icons.chevron_right_rounded, size: 20),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _TextLink extends StatelessWidget {
  const _TextLink({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Align(
          alignment: Alignment.centerRight,
          child:
              Text(label, style: Type.body.copyWith(color: EvabobColors.blue)),
        ),
      ),
    );
  }
}
