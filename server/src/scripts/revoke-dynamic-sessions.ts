/** Revoke Dynamic sessions for every provider user without logging identities. */
import { config } from "../config.js";

if (!config.dynamic.apiToken || !config.dynamic.environmentId) {
  throw new Error("DYNAMIC_API_TOKEN and DYNAMIC_ENVIRONMENT_ID are required");
}

const base = `https://app.dynamicauth.com/api/v0/environments/${encodeURIComponent(config.dynamic.environmentId)}`;
const list = await fetch(`${base}/users`, {
  headers: { Authorization: `Bearer ${config.dynamic.apiToken}` },
});
if (!list.ok) {
  throw new Error(`Dynamic user listing failed with HTTP ${list.status}`);
}
const payload = await list.json() as { users?: Array<{ id?: unknown }> };
const subjects = new Set(
  (payload.users ?? [])
    .map((user) => user.id)
    .filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)),
);

let revoked = 0;
let absent = 0;
for (const subject of subjects) {
  let response = await fetch(`${base}/users/${encodeURIComponent(subject)}/sessions/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.dynamic.apiToken}` },
  });
  // Some older dashboard tokens can list environment users but only carry
  // permission for Dynamic's deprecated unscoped revoke endpoint.
  if (response.status === 403) {
    response = await fetch(
      `https://app.dynamicauth.com/api/v0/users/${encodeURIComponent(subject)}/sessions/revoke`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${config.dynamic.apiToken}` },
      },
    );
  }
  if (response.status === 204) revoked += 1;
  else if (response.status === 404) absent += 1;
  else throw new Error(`Dynamic session revocation failed with HTTP ${response.status}`);
}
console.log(JSON.stringify({ candidateUsers: subjects.size, revoked, absent }));
