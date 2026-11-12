import 'package:flutter/material.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';
import '../../core/config/app_features.dart';
import 'package:provider/provider.dart';

/// Where the old button grid went.
///
/// Request, Buy, Unified, Agent, Bridge and Profile used to sit on the home
/// screen as a row of icons. They are all real, and all rare — putting them
/// behind the dots keeps the screen about the two things people open the app
/// to do.
///
/// The labels are the brief's, not the code's: Buy is "Convert", Bridge is
/// "Move money", Unified is "Your Gateway Account". A person should not have to know what a
/// bridge is to move their own money.
enum HomeMenuAction {
  market,
  request,
  sellWithLink,
  paywalls,
  agentTasks,
  groups,
  convert,
  ga,
  agent,
  moveMoney,
}

Future<HomeMenuAction?> showHomeMenu(BuildContext context) {
  return showModalBottomSheet<HomeMenuAction>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    // A sheet that springs up, per the brief. The bounce comes from the
    // transition curve, not from the sheet dragging.
    transitionAnimationController: null,
    builder: (context) => const _Menu(),
  );
}

/// One thing the menu opens: what it is called, its picture, and the line
/// that explains it (read out by a screen reader, shown on a long press).
typedef _MenuItem = ({
  HomeMenuAction action,
  IconData icon,
  String label,
  String hint,
});

class _Menu extends StatelessWidget {
  const _Menu();

  // The order is the product owner's. Keep it when adding or moving items.
  static const List<_MenuItem> _items = [
    (
      action: HomeMenuAction.market,
      icon: Icons.storefront_rounded,
      label: 'Marketplace',
      hint: 'Buy, sell, or post what you need and get offers from people near you',
    ),
    (
      action: HomeMenuAction.request,
      icon: Icons.request_quote_rounded,
      label: 'Request',
      hint: 'Ask someone to pay you',
    ),
    (
      action: HomeMenuAction.sellWithLink,
      icon: Icons.add_link_rounded,
      label: 'Sell with a link',
      hint: "Buyers' money is set aside until their order arrives",
    ),
    (
      action: HomeMenuAction.groups,
      icon: Icons.diversity_3_rounded,
      label: 'Circles and collections',
      hint: 'Save together, or raise money for something',
    ),
    (
      action: HomeMenuAction.paywalls,
      icon: Icons.sell_rounded,
      label: 'Get paid by agents',
      hint: 'Charge software for a dataset, photos, your API or your time',
    ),
    (
      action: HomeMenuAction.agentTasks,
      icon: Icons.work_rounded,
      label: 'Work for agents',
      hint: 'Tasks software will pay you for, money set aside first',
    ),
    (
      action: HomeMenuAction.convert,
      icon: Icons.currency_exchange_rounded,
      label: 'Convert',
      hint: 'Change dollars to euros, or back',
    ),
    (
      action: HomeMenuAction.ga,
      icon: Icons.account_balance_wallet_rounded,
      label: 'Gateway Account',
      hint: 'The balance you spend from',
    ),
    (
      action: HomeMenuAction.moveMoney,
      icon: Icons.multiple_stop_rounded,
      label: 'Move money',
      hint: 'Between the networks you hold money on',
    ),
    (
      action: HomeMenuAction.agent,
      icon: Icons.smart_toy_rounded,
      label: 'Agent wallets',
      hint: 'Money set aside for software to spend',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final features = context.watch<AppFeatures>();
    final visible = _items.where((item) {
      return switch (item.action) {
        HomeMenuAction.market => true,
        HomeMenuAction.request => features.requests,
        HomeMenuAction.sellWithLink => true,
        HomeMenuAction.paywalls => true,
        HomeMenuAction.agentTasks => true,
        HomeMenuAction.groups => true,
        HomeMenuAction.convert => features.conversion,
        HomeMenuAction.ga => features.gateway,
        HomeMenuAction.moveMoney => features.bridge,
        HomeMenuAction.agent => features.agentWallets,
      };
    }).toList(growable: false);
    // Large-text settings would push two-line labels out of their tiles.
    final scaler = MediaQuery.textScalerOf(context)
        .clamp(minScaleFactor: 1, maxScaleFactor: 1.3);
    return SafeArea(
      top: false,
      child: Container(
        margin: const EdgeInsets.all(Space.md),
        decoration: BoxDecoration(
          color: EvabobColors.sheet,
          borderRadius: Radii.all(Radii.lg),
          border: Border.all(color: EvabobColors.hairline),
          boxShadow: Shadows.raised,
        ),
        padding:
            const EdgeInsets.fromLTRB(Space.md, Space.sm, Space.md, Space.lg),
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: scaler),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: EvabobColors.hairline,
                  borderRadius: Radii.all(Radii.pill),
                ),
              ),
              const SizedBox(height: Space.md),
              Flexible(
                child: GridView.builder(
                  shrinkWrap: true,
                  padding: EdgeInsets.zero,
                  gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 3,
                    mainAxisExtent: 76 + scaler.scale(12) * 2 * 1.25,
                    crossAxisSpacing: Space.sm,
                    mainAxisSpacing: Space.sm,
                  ),
                  itemCount: visible.length,
                  itemBuilder: (context, i) => PopIn(
                    index: i,
                    child: _Tile(
                      item: visible[i],
                      onTap: () => Navigator.pop(context, visible[i].action),
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

class _Tile extends StatelessWidget {
  const _Tile({required this.item, required this.onTap});

  final _MenuItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: item.hint,
      child: Semantics(
        button: true,
        label: item.label,
        hint: item.hint,
        excludeSemantics: true,
        child: PressScale(
          onTap: onTap,
          scale: 0.92,
          child: ColoredBox(
            // Makes the whole tile, not only the picture, take the tap.
            color: Colors.transparent,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.start,
              children: [
                Container(
                  width: 56,
                  height: 56,
                  decoration: BoxDecoration(
                    color: EvabobColors.pageBg,
                    borderRadius: Radii.all(Radii.md),
                  ),
                  child: Icon(item.icon, size: 26, color: EvabobColors.primary),
                ),
                const SizedBox(height: Space.sm),
                Text(
                  item.label,
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.25,
                    letterSpacing: -0.1,
                    color: EvabobColors.nearBlack,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
