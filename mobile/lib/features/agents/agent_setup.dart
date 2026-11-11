import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/config/env.dart';
import '../../core/theme/evabob_colors.dart';
import '../../core/widgets/top_snack.dart';

/// Ready-to-paste setup for an agent wallet key.
///
/// The key is not a private key — Evabob signs for the wallet — so software
/// has to be told where to send its requests. "POST /v1/x402/pay" with no
/// address and no body was not enough for anyone to act on. These are the
/// three things people actually paste: a note for an AI assistant, a command
/// for Claude, and a request for a script.
///
/// [apiKey] is only ever passed at the moment a key is issued; afterwards the
/// app no longer has it and the text carries a placeholder.
class AgentSetupText {
  AgentSetupText({String? apiKey, String? baseUrl})
      : key = apiKey ?? keyPlaceholder,
        base =
            (baseUrl ?? Env.resolveApiBaseUrl()).replaceAll(RegExp(r'/+$'), '');

  static const keyPlaceholder = 'sk_evabob_YOUR_KEY';

  final String key;
  final String base;

  String get guideUrl => '$base/v1/public/agent-guide';

  /// For any assistant that can make web requests.
  String get forAssistant =>
      'You can pay for paid APIs (x402) with my Evabob agent wallet.\n'
      'Read the instructions first: $guideUrl\n'
      'To pay for a URL: POST $base/v1/x402/pay\n'
      'Header: Authorization: Bearer $key\n'
      'JSON body: {"url": "<the paid URL>"} '
      '(add "method" and "body" for POST sellers).\n'
      'Check the balance and what is left: GET $base/v1/agent-api/me\n'
      'If a payment answers APPROVAL_PENDING I am being asked on my phone: '
      'wait, then retry with the same idempotencyKey. '
      'If it answers AGENT_PAUSED or LOOP_BREAKER, stop and tell me.';

  /// Adds the wallet to Claude as a tool (MCP).
  String get forClaude =>
      'claude mcp add --transport http evabob $base/v1/agent-api/mcp '
      '--header "Authorization: Bearer $key"';

  /// One request, for a terminal or a script.
  String get forScript => 'curl -X POST $base/v1/x402/pay \\\n'
      '  -H "Authorization: Bearer $key" \\\n'
      '  -H "Content-Type: application/json" \\\n'
      '  -d \'{"url":"https://api.botpay.network/pay"}\'';
}

/// Three buttons that each copy one way of connecting software.
class AgentSetupButtons extends StatelessWidget {
  const AgentSetupButtons({super.key, this.apiKey});

  /// Present only while a new key is on screen.
  final String? apiKey;

  Future<void> _copy(BuildContext context, String text, String what) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!context.mounted) return;
    showTopSnack(
      context,
      SnackBar(
        content: Text(apiKey == null
            ? '$what copied. Put your key where it says '
                '${AgentSetupText.keyPlaceholder}.'
            : '$what copied, with the key in it.'),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final text = AgentSetupText(apiKey: apiKey);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        _SetupChip(
          icon: Icons.auto_awesome_rounded,
          label: 'For an AI assistant',
          onTap: () => _copy(context, text.forAssistant, 'Instructions'),
        ),
        _SetupChip(
          icon: Icons.extension_rounded,
          label: 'For Claude',
          onTap: () => _copy(context, text.forClaude, 'Command'),
        ),
        _SetupChip(
          icon: Icons.terminal_rounded,
          label: 'For a script',
          onTap: () => _copy(context, text.forScript, 'Request'),
        ),
      ],
    );
  }
}

class _SetupChip extends StatelessWidget {
  const _SetupChip({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ActionChip(
      avatar: Icon(icon, size: 16, color: EvabobColors.primary),
      label: Text(label, style: const TextStyle(fontSize: 12)),
      onPressed: onTap,
      backgroundColor: EvabobColors.pageBg,
      side: BorderSide.none,
      tooltip: 'Copy setup $label'.replaceFirst('For', 'for'),
    );
  }
}
