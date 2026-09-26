import 'package:flutter/widgets.dart';

/// Phone builds use the WebView in [CircleChallengeScreen]; never built.
class ChallengeFrame extends StatelessWidget {
  const ChallengeFrame({
    super.key,
    required this.payload,
    required this.onMessage,
    required this.onStarted,
  });

  final Map<String, dynamic> payload;
  final void Function(String message) onMessage;
  final VoidCallback onStarted;

  @override
  Widget build(BuildContext context) =>
      throw UnsupportedError('ChallengeFrame exists only in the web-app');
}
