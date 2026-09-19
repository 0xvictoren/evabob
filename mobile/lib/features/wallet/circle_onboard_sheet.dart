import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/theme/evabob_colors.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import 'package:evabob_mobile/core/widgets/top_snack.dart';

/// Ensure spendable wallet is ready (PIN + multi-chain addresses).
Future<bool> openCircleWalletOnboarding(
  BuildContext context, {
  bool silent = false,
}) async {
  final circle = context.read<CircleWalletService>();
  try {
    final ok = await circle.ensureReady(context, silent: silent);
    if (!context.mounted) return ok;
    if (ok) {
      await context.read<WalletService>().refreshBalances(
            addressOverride: circle.address,
            force: true,
          );
    }
    if (!context.mounted) return ok;
    if (!silent) {
      showTopSnack(
        context,
        SnackBar(
          content: Text(
            ok && circle.address != null
                ? 'Wallet ready: ${circle.address!.substring(0, 10)}…'
                : ok
                    ? 'Wallet session ready'
                    : 'Wallet setup incomplete — try again',
          ),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
    return ok;
  } catch (e) {
    if (!context.mounted) return false;
    if (!silent) {
      showTopSnack(
        context,
        SnackBar(
          content: Text(_friendly(e)),
          behavior: SnackBarBehavior.floating,
          backgroundColor: EvabobColors.danger,
        ),
      );
    }
    return false;
  }
}

String _friendly(Object e) {
  final s = e.toString().toLowerCase();
  if (s.contains('already') || s.contains('existing user')) {
    return 'Account exists — finishing wallet setup…';
  }
  return e
      .toString()
      .replaceFirst(RegExp(r'^Exception:\s*'), '')
      .replaceFirst(RegExp(r'^ApiException\(\d+\):\s*'), '');
}
