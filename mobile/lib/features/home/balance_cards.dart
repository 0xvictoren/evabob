import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/theme/evabob_tokens.dart';
import '../../core/utils/money_format.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/glass.dart';
import '../../core/widgets/motion.dart';

/// The Home balance — the user's spendable money on Arc, and nothing else.
///
/// This started as a pill row of Arc/ETH/Base/EURC/cirBTC, then a swipeable
/// card per network. Both asked someone to understand what a network is before
/// they could read their own balance. The app runs on Arc: Home shows the Arc
/// balance, the full cross-network picture lives on the Assets screen, and Home
/// never names a network.
///
/// Dollars are the hero. Euros, when the user holds any, sit underneath as a
/// quiet second line — one hero element, not two competing numbers.
class ArcBalance extends StatelessWidget {
  const ArcBalance({super.key});

  @override
  Widget build(BuildContext context) {
    final wallet = context.watch<WalletService>();
    final dollars = wallet.usdcWallet;
    final euros = wallet.eurcWallet;

    // Whichever they actually hold leads. Almost always dollars.
    final heroIsEuros = dollars <= 0 && euros > 0;
    final heroValue = heroIsEuros ? euros : dollars;
    final heroToken = heroIsEuros ? 'EURC' : 'USDC';
    final secondValue = heroIsEuros ? 0.0 : euros;

    return Glass(
      heavy: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Your money',
            style: Type.caption.copyWith(color: EvabobColors.navyMuted),
          ),
          const SizedBox(height: Space.sm),
          CountUp(
            heroValue,
            builder: (context, v) => _HeroFigure(
              text: formatMoney(v, heroToken),
            ),
          ),
          if (secondValue > 0) ...[
            const SizedBox(height: Space.xs),
            Text(
              'and ${formatMoney(secondValue, 'EURC')}',
              style: Type.body.copyWith(color: EvabobColors.navyMuted),
            ),
          ],
        ],
      ),
    );
  }
}

/// The figure itself: whole part big, cents smaller and raised.
class _HeroFigure extends StatelessWidget {
  const _HeroFigure({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final dot = text.lastIndexOf('.');
    final whole = dot < 0 ? text : text.substring(0, dot);
    final frac = dot < 0 ? '' : text.substring(dot);

    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerLeft,
      child: RichText(
        text: TextSpan(
          style: Type.hero.copyWith(color: EvabobColors.nearBlack),
          children: [
            TextSpan(text: whole),
            if (frac.isNotEmpty) TextSpan(text: frac, style: Type.heroFraction),
          ],
        ),
      ),
    );
  }
}
