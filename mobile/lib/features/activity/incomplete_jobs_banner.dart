import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/activity/activity_service.dart';
import '../../core/utils/text_safe.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/wallet/circle_wallet_service.dart';
import '../../core/wallet/wallet_service.dart';
import '../../core/widgets/glass.dart';

/// Incomplete bridge/swap PIN jobs — Continue instead of losing funds.
class IncompleteJobsBanner extends StatelessWidget {
  const IncompleteJobsBanner({super.key});

  String _label(Map<String, dynamic> job) {
    final meta = job['meta'];
    if (meta is Map && meta['label'] != null) {
      return meta['label'].toString();
    }
    final op = job['op']?.toString() ?? 'transfer';
    return op[0].toUpperCase() + op.substring(1);
  }

  static Future<void> continueJob(BuildContext context, String jobId) async {
    final circle = context.read<CircleWalletService>();
    final activity = context.read<ActivityService>();
    final wallet = context.read<WalletService>();
    final res = await circle.resumeAppKitJob(context: context, jobId: jobId);
    if (!context.mounted) return;
    try {
      await activity.refresh();
      await wallet.refreshBalances(
        addressOverride: circle.address,
        force: true,
        silent: true,
      );
      await circle.refreshOpenJobs();
    } catch (_) {}
    if (!context.mounted) return;
    final ok = res['ok'] == true;
    final paused = res['stage']?.toString() == 'paused';
    final fundsIntact = res['fundsIntact'] == true;
    final notice = circle.takeFundsIntactNotice();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          fundsIntact
              ? (notice ??
                  res['message']?.toString() ??
                  'PIN expired. Your funds were not moved.')
              : ok
                  ? 'Transfer finished'
                  : paused
                      ? 'Paused — open Activity to Continue'
                      : friendlyError(
                          res['error'] ?? notice,
                          fallback: 'That transfer did not finish.',
                        ),
        ),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final jobs = context.watch<CircleWalletService>().openJobs;
    if (jobs.isEmpty) return const SizedBox.shrink();
    return Column(
      children: [
        for (final job in jobs.take(3))
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Glass(
              heavy: true,
              child: Row(
                children: [
                  const Icon(
                    Icons.pending_actions_rounded,
                    color: EvabobColors.danger,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Incomplete ${_label(job)}',
                          style: const TextStyle(
                            fontWeight: FontWeight.w400,
                            color: EvabobColors.navy,
                          ),
                        ),
                        const Text(
                          'PIN was started. Continue to finish so funds are not stuck.',
                          style: TextStyle(
                            fontSize: 10,
                            color: EvabobColors.navyMuted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  FilledButton(
                    onPressed: () {
                      final id = job['jobId']?.toString();
                      if (id == null || id.isEmpty) return;
                      IncompleteJobsBanner.continueJob(context, id);
                    },
                    child: const Text('Continue'),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}
