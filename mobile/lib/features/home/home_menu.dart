import 'package:flutter/material.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
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
/// "Move money", Unified is "Your GA". A person should not have to know what a
/// bridge is to move their own money.
enum HomeMenuAction { request, convert, ga, agent, moveMoney, profile }

Future<HomeMenuAction?> showHomeMenu(BuildContext context) {
  return showModalBottomSheet<HomeMenuAction>(
    context: context,
    backgroundColor: Colors.transparent,
    // A sheet that springs up, per the brief. The bounce comes from the
    // transition curve, not from the sheet dragging.
    transitionAnimationController: null,
    builder: (context) => const _Menu(),
  );
}

class _Menu extends StatelessWidget {
  const _Menu();

  static const _items = [
    (
      HomeMenuAction.request,
      Icons.request_quote_outlined,
      'Request',
      'Ask someone to pay you'
    ),
    (
      HomeMenuAction.convert,
      Icons.swap_horiz_rounded,
      'Convert',
      'Change dollars to euros, or back'
    ),
    (
      HomeMenuAction.ga,
      Icons.account_balance_wallet_outlined,
      'Your GA',
      'The balance you spend from'
    ),
    (
      HomeMenuAction.moveMoney,
      Icons.alt_route_rounded,
      'Move money',
      'Between the networks you hold money on'
    ),
    (
      HomeMenuAction.agent,
      Icons.smart_toy_outlined,
      'Agent wallets',
      'Money set aside for software to spend'
    ),
    (
      HomeMenuAction.profile,
      Icons.person_outline_rounded,
      'Profile',
      'Your name, handle and wallet'
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final features = context.watch<AppFeatures>();
    final visible = _items.where((item) {
      return switch (item.$1) {
        HomeMenuAction.request => features.requests,
        HomeMenuAction.convert => features.conversion,
        HomeMenuAction.ga => features.gateway,
        HomeMenuAction.moveMoney => features.bridge,
        HomeMenuAction.agent => features.agentWallets,
        HomeMenuAction.profile => true,
      };
    }).toList(growable: false);
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
        padding: const EdgeInsets.symmetric(vertical: Space.sm),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < visible.length; i++)
              RiseIn(
                index: i,
                child: ListTile(
                  leading: Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: EvabobColors.sand,
                      borderRadius: Radii.all(Radii.sm),
                    ),
                    child: Icon(visible[i].$2,
                        size: 19, color: EvabobColors.nearBlack),
                  ),
                  title: Text(
                    visible[i].$3,
                    style: Type.label.copyWith(color: EvabobColors.nearBlack),
                  ),
                  subtitle: Text(
                    visible[i].$4,
                    style: Type.caption.copyWith(color: EvabobColors.navyMuted),
                  ),
                  onTap: () => Navigator.pop(context, visible[i].$1),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
