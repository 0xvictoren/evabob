import 'package:flutter/material.dart';

import '../theme/evabob_colors.dart';

/// A yes/no step in front of something that cannot be taken back.
///
/// The agent-wallet screen already did this properly — Fund, Withdraw, Rotate
/// and Revoke each state what happens before they happen — while the places
/// where money actually leaves did not. Releasing a hold, marking work
/// delivered and signing out were all a single tap with nothing in between.
///
/// The message is the whole point: say what happens to the money, in the
/// second person, in one or two sentences. Not "Are you sure?".
Future<bool> confirmAction(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  String cancelLabel = 'Cancel',
  bool destructive = false,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx, false),
          child: Text(cancelLabel),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor:
                destructive ? EvabobColors.alert : EvabobColors.emerald,
          ),
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return ok == true;
}
