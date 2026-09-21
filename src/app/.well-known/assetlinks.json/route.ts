const packageName = "com.evabob.evabob_mobile";

export function GET() {
  const fingerprints = (process.env.ANDROID_APP_CERT_SHA256 ?? "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value));

  const body = fingerprints.length
    ? [
        {
          relation: ["delegate_permission/common.handle_all_urls"],
          target: {
            namespace: "android_app",
            package_name: packageName,
            sha256_cert_fingerprints: fingerprints,
          },
        },
      ]
    : [];

  return Response.json(body, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
