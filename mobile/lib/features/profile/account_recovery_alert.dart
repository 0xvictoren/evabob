import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/utils/text_safe.dart';
import '../../core/widgets/top_snack.dart';

/// Opened from the "Account recovery requested" alert.
///
/// A new sign-in with this account's email asked to take the account over.
/// The server waits 24 hours after the emailed code is confirmed before it
/// completes, so the owner has time to stop it — this is where they do.
Future<void> showAccountRecoveryAlert(
  BuildContext context,
  String requestId,
) async {
  final stop = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Was this you?'),
      content: const Text(
        'Someone signed in with your email on another device and asked to '
        'take over this Evabob account. If it was not you, stop it now and '
        'change your email password.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: const Text('It was me'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text('Stop it'),
        ),
      ],
    ),
  );
  if (stop != true || !context.mounted) return;
  try {
    await context
        .read<ApiClient>()
        .post('/v1/users/recovery/${Uri.encodeComponent(requestId)}/cancel');
    if (!context.mounted) return;
    showTopSnack(
      context,
      const SnackBar(
        content: Text('Stopped. Your account stays with you.'),
        behavior: SnackBarBehavior.floating,
      ),
    );
  } catch (error) {
    if (!context.mounted) return;
    showTopSnack(
      context,
      SnackBar(
        content: Text(
          friendlyError(error, fallback: 'That request could not be stopped.'),
        ),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}
