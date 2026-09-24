import 'package:flutter/material.dart';
import 'dart:async';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../held/held_payment_screen.dart';
import '../../core/notifications/money_alerts.dart';
import '../../core/held/held_payments_api.dart';
import '../../core/api/api_client.dart';
import '../../core/auth/evabob_auth.dart';
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
import '../activity/activity_thumb.dart';
import '../groups/groups_screen.dart';
import '../hold_links/hold_links_screen.dart';
import '../agent_tasks/agent_tasks_screen.dart';
import '../paywalls/paywalls_screen.dart';
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
    this.onNotifications,
    required this.onProfile,
    required this.onBridge,
    required this.onAgents,
    required this.onChatList,
    this.onGateway,
    this.onRequest,
    this.onSendTo,
    this.onOpenRequest,
  });

  /// Send with the payee already filled in (a scanned code).
  final ValueChanged<String>? onSendTo;

  /// A scanned payment request.
  final ValueChanged<String>? onOpenRequest;

  final VoidCallback onSend;
  final VoidCallback onFund;
  final VoidCallback onExchange;
  final VoidCallback onActivity;
  final VoidCallback? onNotifications;
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
  /// "Your money" opened out to list everything.
  bool _moneyExpanded = false;

  /// Scan from Home goes straight to Send with the person filled in — every
  /// payment here runs on Arc, so there is no network to choose.
  Future<void> _scanToPay() async {
    final hit = await AddressScanSheet.open(context, title: 'Scan to pay');
    if (!mounted || hit == null) return;
    final request = hit.requestId;
    if (request != null && request.isNotEmpty) {
      widget.onOpenRequest?.call(request);
      return;
    }
    if (hit.payee.isEmpty) return;
    final to = widget.onSendTo;
    if (to != null) {
      to(hit.payee);
    } else {
      widget.onSend();
    }
  }

  /// Held money still in motion: a payment waiting out its 10 minutes, money
  /// set aside for work or an order, a claim link waiting for someone to join.
  List<HeldPayment> _held = const [];
  StreamSubscription<Map<String, dynamic>>? _alerts;

  Future<void> _loadHeld() async {
    try {
      final all = await HeldPaymentsApi(context.read<ApiClient>()).list();
      if (!mounted) return;
      setState(() => _held = all.where((h) => !h.stage.settled).toList());
    } catch (_) {
      // Keeps what it showed; the next refresh tries again.
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      final circle = context.read<CircleWalletService>();
      // Anything that moves held or GA money changes "Your money".
      _alerts = context.read<MoneyAlerts>().events.listen((a) {
        final kind = a['kind']?.toString() ?? '';
        if (!mounted) return;
        if (kind.startsWith('hold_') || kind.startsWith('ga_')) {
          _loadHeld();
          context.read<ActivityService>().refresh();
        }
      });
      await Future.wait([
        context.read<WalletService>().refreshBalances(
              addressOverride: circle.address,
              silent: true,
            ),
        context.read<ActivityService>().refresh(),
        context.read<ChatService>().refreshThreads(),
        circle.refreshOpenJobs(),
        _loadHeld(),
      ]);
    });
  }

  @override
  void dispose() {
    _alerts?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final circle = context.read<CircleWalletService>();
    await Future.wait([
      context.read<AppFeatures>().refresh(),
      context.read<WalletService>().refreshBalances(
            addressOverride: circle.address,
            force: true,
          ),
      context.read<ActivityService>().refresh(),
      context.read<ChatService>().refreshThreads(),
      circle.refreshOpenJobs(),
      _loadHeld(),
    ]);
  }

  Future<void> _openMenu() async {
    final choice = await showHomeMenu(context);
    if (!mounted || choice == null) return;
    switch (choice) {
      case HomeMenuAction.request:
        (widget.onRequest ?? widget.onSend)();
      case HomeMenuAction.sellWithLink:
        Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const HoldLinksScreen()),
        );
      case HomeMenuAction.paywalls:
        Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const PaywallsScreen()),
        );
      case HomeMenuAction.agentTasks:
        Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const AgentTasksScreen()),
        );
      case HomeMenuAction.groups:
        Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const GroupsScreen()),
        );
      case HomeMenuAction.convert:
        widget.onExchange();
      case HomeMenuAction.ga:
        (widget.onGateway ?? widget.onFund)();
      case HomeMenuAction.moveMoney:
        widget.onBridge();
      case HomeMenuAction.agent:
        widget.onAgents();
    }
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
            onNotifications: widget.onNotifications ?? widget.onActivity,
            onProfile: widget.onProfile,
            onSend: widget.onSend,
            onScan: _scanToPay,
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
                      // Opens the full list right here — everything held and
                      // everything in motion — rather than jumping to Move
                      // money.
                      _TextLink(
                        label: _moneyExpanded ? 'Show less ˄' : 'View all ˅',
                        onTap: () =>
                            setState(() => _moneyExpanded = !_moneyExpanded),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  _MoneyCard(
                    expanded: _moneyExpanded,
                    wallet: wallet,
                    jobs: circle.openJobs,
                    held: _held,
                    gaInFlight: activity.items
                        .where((e) => e.kind == 'withdraw' && e.isPending)
                        .toList(),
                    onOpenHeld: (h) async {
                      await Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) =>
                              HeldPaymentScreen(transferId: h.transferId),
                        ),
                      );
                      if (mounted) await _loadHeld();
                    },
                    onOpenActivity: (e) => ReceiptSheet.open(context, e),
                  ),
                  const SizedBox(height: 24),
                  _RecentActivity(
                    activity: activity,
                    onSeeAll: widget.onActivity,
                    onOpen: (entry) => ReceiptSheet.open(context, entry),
                  ),
                  const SizedBox(height: 24),
                  IncomeCard(activity: activity),
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
    // Shown in the person's main currency, the other one underneath.
    final shown = fx.fromUsd(dollars);
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
                  _MenuButton(onTap: onMore),
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
                shown,
                builder: (_, value) {
                  final formatted =
                      fx.isNaira ? formatNgn(value) : formatUsd(value);
                  final dot = formatted.lastIndexOf('.');
                  return FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text.rich(
                      TextSpan(
                        style: Type.hero.copyWith(color: EvabobColors.white),
                        children: [
                          TextSpan(
                            text: dot < 0
                                ? formatted
                                : formatted.substring(0, dot),
                          ),
                          if (dot >= 0)
                            TextSpan(
                              text: formatted.substring(dot),
                              style: Type.hero.copyWith(
                                color: EvabobColors.lightDark,
                              ),
                            ),
                        ],
                      ),
                    ),
                  );
                },
              ),
              Text(
                '≈ ${fx.secondary(dollars)}',
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

/// Figma "menu icon" (`67:3158`): a 44×44 circle of white at 18% holding a
/// 2×2 grid of 10px `#F0FAFF` dots, 3px apart across and 2px down (the
/// Figma geometry). Static — no animation.
class _MenuButton extends StatelessWidget {
  const _MenuButton({required this.onTap});

  final VoidCallback onTap;

  static const _dot = SizedBox(
    width: 10,
    height: 10,
    child: DecoratedBox(
      decoration: BoxDecoration(
        color: EvabobColors.pageBg,
        shape: BoxShape.circle,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: 'More',
      child: PressScale(
        onTap: onTap,
        child: Container(
          width: 44,
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: EvabobColors.white.withValues(alpha: .18),
          ),
          child: const Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [_dot, SizedBox(width: 3), _dot],
              ),
              SizedBox(height: 2),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [_dot, SizedBox(width: 3), _dot],
              ),
            ],
          ),
        ),
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

/// "Your money": every bridge or GA top-up that has not finished, each with
/// where it stands and a tap to continue. "All clear" only when none are.
class _MoneyCard extends StatelessWidget {
  const _MoneyCard({
    required this.expanded,
    required this.wallet,
    required this.jobs,
    required this.held,
    required this.gaInFlight,
    required this.onOpenHeld,
    required this.onOpenActivity,
  });

  /// Everything, not the first few: each balance held and every payment
  /// still in motion.
  final bool expanded;
  final WalletService wallet;
  final List<Map<String, dynamic>> jobs;

  /// Held payments not yet settled, either side of them.
  final List<HeldPayment> held;

  /// GA payments on their way, or waiting for an approval to be final.
  final List<ActivityEntry> gaInFlight;
  final ValueChanged<HeldPayment> onOpenHeld;
  final ValueChanged<ActivityEntry> onOpenActivity;

  static String _heldTitle(HeldPayment h) {
    final amount = formatMoney(h.amountUsdc);
    if (h.isCoolingOff) return 'Sending $amount to ${h.counterparty}';
    if (h.isJob) {
      return h.isPayer
          ? 'Held for ${h.counterparty} · $amount'
          : 'Set aside for you · $amount';
    }
    return 'Waiting for ${h.counterparty} · $amount';
  }

  static String _heldStage(HeldPayment h) {
    switch (h.stage) {
      case HeldStage.coolingOff:
        final left = h.releaseAt?.difference(DateTime.now());
        return left == null || left.isNegative
            ? 'Going now · tap to see'
            : 'Goes in ${left.inMinutes + 1} min · you can still cancel';
      case HeldStage.waitingForDelivery:
        return h.isPayer ? 'Until they deliver' : 'Mark it delivered when done';
      case HeldStage.delivered:
        return h.isPayer
            ? 'Delivered · confirm or it pays itself'
            : 'Delivered · waiting for them';
      case HeldStage.underReview:
        return 'Being reviewed';
      case HeldStage.waitingToClaim:
        return 'Waiting for them to join Evabob';
      default:
        return 'Tap to see where it stands';
    }
  }

  static String _network(String? chain) {
    final c = (chain ?? '').toLowerCase();
    if (c.startsWith('arc')) return 'Arc';
    if (c.startsWith('base')) return 'Base';
    if (c.startsWith('eth')) return 'Ethereum';
    return chain ?? '';
  }

  static double _amount(Map<String, dynamic> job) {
    final meta = job['meta'];
    final raw = meta is Map ? meta['amount'] : null;
    return double.tryParse(raw?.toString() ?? '') ?? 0;
  }

  static String _title(Map<String, dynamic> job) {
    final meta = job['meta'] is Map ? job['meta'] as Map : const {};
    final amount = formatMoney(_amount(job));
    switch (job['op']?.toString()) {
      case 'bridge':
        return 'Moving $amount · ${_network(meta['fromChain']?.toString())}'
            ' → ${_network(meta['toChain']?.toString())}';
      case 'deposit':
        return 'Adding $amount to your GA';
      case 'swap':
        return 'Converting $amount';
      case 'send':
        return 'Sending $amount';
      default:
        return 'Payment of $amount';
    }
  }

  static String _stage(Map<String, dynamic> job) {
    switch (job['stage']?.toString()) {
      case 'sent':
        return 'On its way · tap to finish';
      case 'confirming':
        return 'Confirming on the network';
      default:
        return 'Waiting for your PIN · tap to continue';
    }
  }

  @override
  Widget build(BuildContext context) {
    final pendingTopUp = wallet.gatewayPendingUsdc;
    // All clear only when nothing at all is in motion.
    final clear =
        jobs.isEmpty && pendingTopUp <= 0 && held.isEmpty && gaInFlight.isEmpty;

    Widget row({
      required String title,
      required String subtitle,
      required IconData icon,
      String? trailing,
      VoidCallback? onTap,
    }) {
      return InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
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
                  child: Icon(icon, size: 20, color: EvabobColors.blue),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Type.body,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style:
                            Type.label.copyWith(color: EvabobColors.inkMuted),
                      ),
                    ],
                  ),
                ),
                if (trailing != null) ...[
                  const SizedBox(width: 8),
                  Text(trailing, style: Type.amount),
                ] else if (onTap != null)
                  const Icon(Icons.chevron_right_rounded, size: 20),
              ],
            ),
          ),
        ),
      );
    }

    final fx = context.watch<FxService>();
    final limit = expanded ? 1 << 30 : 4;
    String networkName(Map<String, dynamic> r) {
      final n = r['name']?.toString() ?? '';
      return n.replaceAll(RegExp(r'\s*(Sepolia|Testnet)\s*', caseSensitive: false), '').trim();
    }

    // What the person holds, each pot on its own line. The GA stays off Home.
    final holdings = <Widget>[
      row(
        title: 'Dollars',
        subtitle: 'Spendable · ≈ ${fx.secondary(wallet.usdcWallet)}',
        icon: Icons.attach_money_rounded,
        trailing: fx.primary(wallet.usdcWallet),
      ),
      if (wallet.eurcWallet > 0)
        row(
          title: 'Euros',
          subtitle: 'Spendable · ≈ ${fx.secondaryToken(wallet.eurcWallet, 'EURC')}',
          icon: Icons.euro_rounded,
          trailing: formatEur(wallet.eurcWallet),
        ),
      if (wallet.cirbtcWallet > 0)
        row(
          title: 'Bitcoin',
          subtitle: 'Spendable',
          icon: Icons.currency_bitcoin_rounded,
          trailing: formatMoney(wallet.cirbtcWallet, 'CIRBTC'),
        ),
      for (final r in wallet.chainBalances)
        if (r['id']?.toString() != 'arc' &&
            ((r['usdc'] as num?)?.toDouble() ?? 0) > 0)
          row(
            title: 'Dollars on ${networkName(r)}',
            subtitle: 'Move it to Arc to spend it',
            icon: Icons.alt_route_rounded,
            trailing: fx.primary((r['usdc'] as num).toDouble()),
          ),
    ];

    final rows = <Widget>[
      if (expanded) ...holdings,
      if (clear)
        row(
          title: 'All clear',
          subtitle: 'No payments are waiting',
          icon: Icons.check_rounded,
          trailing: formatMoney(0),
        ),
      for (final job in jobs.take(limit))
        row(
          title: _title(job),
          subtitle: _stage(job),
          icon: job['op']?.toString() == 'deposit'
              ? Icons.account_balance_wallet_outlined
              : Icons.alt_route_rounded,
          onTap: job['stage']?.toString() == 'confirming'
              ? null
              : () {
                  final id = job['jobId']?.toString();
                  if (id == null || id.isEmpty) return;
                  IncompleteJobsBanner.continueJob(context, id);
                },
        ),
      if (pendingTopUp > 0)
        row(
          title: 'Adding ${formatMoney(pendingTopUp)} to your GA',
          subtitle: 'Confirming on the network',
          icon: Icons.account_balance_wallet_outlined,
        ),
      for (final h in held.take(limit))
        row(
          title: _heldTitle(h),
          subtitle: _heldStage(h),
          icon: h.isCoolingOff
              ? Icons.hourglass_top_rounded
              : Icons.lock_clock_outlined,
          onTap: () => onOpenHeld(h),
        ),
      for (final e in gaInFlight.take(limit))
        row(
          title: 'Paying ${formatMoney(e.displayAmount)} from your GA',
          subtitle: e.mode == 'gateway_pay_scheduled'
              ? 'Goes by itself once your approval is confirmed'
              : 'On its way',
          icon: Icons.account_balance_wallet_outlined,
          onTap: () => onOpenActivity(e),
        ),
    ];

    return Container(
      decoration: const BoxDecoration(
        color: EvabobColors.white,
        borderRadius: BorderRadius.all(Radius.circular(12)),
        boxShadow: Shadows.card,
      ),
      child: Column(
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            rows[i],
            if (i != rows.length - 1)
              const Padding(
                padding: EdgeInsets.only(left: 68),
                child: Divider(),
              ),
          ],
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
              ActivityThumb(entry: entry),
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
              // Nothing has left the wallet while a payment is on hold, so
              // don't show it as money already taken.
              Text(
                entry.isPending
                    ? 'On hold'
                    : '${entry.positive ? '+' : ''}$amount',
                style: entry.isPending
                    ? Type.label.copyWith(color: EvabobColors.inkMuted)
                    : Type.amount.copyWith(
                        color: entry.positive
                            ? EvabobColors.moneyIn
                            : EvabobColors.ink,
                      ),
              ),
            ],
          ),
        ),
      ),
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
