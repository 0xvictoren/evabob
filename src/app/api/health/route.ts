export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    service: "evabob-web",
    environment: process.env.EVABOB_ENV || "local",
  });
}
