import 'package:flutter/material.dart';

import '../theme/evabob_colors.dart';

/// Branded thumbnails for the assets and networks supported by Evabob.
///
/// Token codes stay internal. Customer-facing labels should use [displayName]
/// and [symbol].
class AssetThumbnail extends StatelessWidget {
  const AssetThumbnail({
    super.key,
    required this.asset,
    this.size = 40,
    this.semanticLabel,
  });

  final String asset;
  final double size;
  final String? semanticLabel;

  static String _key(String value) {
    final key = value.toLowerCase().replaceAll('_', '-');
    if (key.contains('ethereum') || key == 'eth') return 'eth';
    if (key.contains('base')) return 'base';
    if (key.contains('arc')) return 'arc';
    if (key.contains('btc')) return 'cirbtc';
    if (key.contains('eur')) return 'eurc';
    return 'usdc';
  }

  static String displayName(String value) {
    switch (_key(value)) {
      case 'eth':
        return 'Ethereum';
      case 'base':
        return 'Base';
      case 'arc':
        return 'Arc';
      case 'eurc':
        return 'Euros';
      case 'cirbtc':
        return 'Bitcoin';
      default:
        return 'Dollars';
    }
  }

  static String symbol(String value) => switch (_key(value)) {
        'eurc' => '€',
        'cirbtc' => '₿',
        _ => r'$',
      };

  @override
  Widget build(BuildContext context) {
    final key = _key(asset);
    return Semantics(
      image: true,
      label: semanticLabel ?? displayName(asset),
      child: Container(
        width: size,
        height: size,
        padding: EdgeInsets.all(size * .08),
        decoration: const BoxDecoration(
          color: EvabobColors.white,
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: Color(0x0F0B1620),
              blurRadius: 10,
              offset: Offset(0, 3),
            ),
          ],
        ),
        child: Image.asset(
          'assets/icons-png/$key.png',
          fit: BoxFit.contain,
          filterQuality: FilterQuality.high,
          excludeFromSemantics: true,
        ),
      ),
    );
  }
}
