export const PLAINTEXT_AGENT_KEY_REMEDIATION =
  "plaintextAgentKeysPurgedAt" as const;

type RemediationResult = {
  firstRun: boolean;
  revoked: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Removes the legacy plaintext agent-key field exactly once.
 *
 * The persisted marker turns this bootstrap migration into a startup guard:
 * after the first clean run, any reappearance of apiKeyFull is an integrity
 * failure and the process refuses to start instead of silently hiding it.
 */
export function remediatePlaintextAgentKeys(
  app: Record<string, unknown>,
  incidentAt: string,
): RemediationResult {
  const security = record(app.security) ? app.security : {};
  const alreadyRemediated =
    typeof security[PLAINTEXT_AGENT_KEY_REMEDIATION] === "string" &&
    Boolean(String(security[PLAINTEXT_AGENT_KEY_REMEDIATION]).trim());
  const agents = Array.isArray(app.agents) ? app.agents : [];
  const exposed = agents.filter(
    (value) => record(value) && Object.prototype.hasOwnProperty.call(value, "apiKeyFull"),
  ) as Record<string, unknown>[];

  if (alreadyRemediated && exposed.length > 0) {
    throw new Error(
      "Refusing to start: plaintext agent keys reappeared after security remediation",
    );
  }
  if (alreadyRemediated) return { firstRun: false, revoked: 0 };

  for (const agent of exposed) {
    delete agent.apiKeyFull;
    agent.revokedAt = incidentAt;
  }
  security[PLAINTEXT_AGENT_KEY_REMEDIATION] = incidentAt;
  app.security = security;
  return { firstRun: true, revoked: exposed.length };
}
