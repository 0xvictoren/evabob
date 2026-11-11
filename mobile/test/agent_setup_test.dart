import 'package:evabob_mobile/features/agents/agent_setup.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const base = 'https://api.example.com/';

  test('setup text carries the server address and the key', () {
    final t = AgentSetupText(apiKey: 'sk_evabob_abc', baseUrl: base);
    expect(t.forScript, contains('https://api.example.com/v1/x402/pay'));
    expect(t.forScript, contains('Bearer sk_evabob_abc'));
    expect(t.forClaude, contains('https://api.example.com/v1/agent-api/mcp'));
    expect(t.forClaude, contains('--transport http'));
    expect(t.forAssistant, contains('/v1/public/agent-guide'));
    expect(t.forAssistant, contains('APPROVAL_PENDING'));
    // No doubled slash from a base address that ends in one.
    expect(t.forScript, isNot(contains('.com//v1')));
  });

  test('without a key the text shows where to put one', () {
    final t = AgentSetupText(baseUrl: base);
    expect(t.forScript, contains(AgentSetupText.keyPlaceholder));
    expect(t.forClaude, contains(AgentSetupText.keyPlaceholder));
    expect(t.forAssistant, contains(AgentSetupText.keyPlaceholder));
  });
}
