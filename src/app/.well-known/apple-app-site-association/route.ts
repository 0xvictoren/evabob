const bundleId = "com.evabob.evabobMobile";

export function GET() {
  const teamId = (process.env.APPLE_TEAM_ID ?? "").trim().toUpperCase();
  const details = /^[A-Z0-9]{10}$/.test(teamId)
    ? [
        {
          appID: `${teamId}.${bundleId}`,
          paths: [
            "/send/*",
            "/pay/*",
            "/held/*",
            "/group/*",
            "/agents/*",
            "/task/*",
            "/hold/*",
            "/review/*",
            "/chat/*",
            "/claim/*",
          ],
        },
      ]
    : [];

  return Response.json(
    { applinks: { apps: [], details } },
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
