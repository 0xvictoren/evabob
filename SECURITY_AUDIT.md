# Evabob Security and Privacy Audit

**Audit date:** 2026-09-19  
**Scope:** Next.js public-link application, Flutter mobile application, Hono/Node API, JSON/Mongo persistence, Dynamic authentication, Circle user- and developer-controlled wallets, agent/x402 functions, and Arc smart contracts.  
**Method:** Adversarial static review, trust-boundary and data-flow analysis, local state inspection without disclosing secrets, dependency audit, and review of installed framework guidance. This was not a production-infrastructure penetration test.

## 1. Executive Summary

### Overall risk rating: Critical

This product is not ready to handle real consumer money or private conversations in its current state. The audited Android build permits and is configured to use cleartext HTTP for the authenticated API. A hostile Wi-Fi participant can steal reusable Dynamic bearer tokens and Circle session material, read private financial/chat data, and tamper with payment workflows. That is an immediately exploitable, ordinary-network attack against non-technical users.

The privacy architecture is also fundamentally unsafe for a consumer product. Email-derived identifiers are hashed deterministically and published in an Arc registry, which does not anonymize them: an attacker can hash a known email and resolve it to a wallet address. Held-payment and milestone memo text is stored and emitted on-chain forever. Separately, chat/review photos are served without authorization, financial and contact data is sent to DeepSeek without an accessible privacy notice, and the UI claims account deletion will remove data even though no deletion workflow exists.

The authentication boundary is under-validated. Dynamic JWTs are accepted without enforcing the required issuer or a mandatory `user:basic` scope, and an email claim is used to attach a new Dynamic subject to an existing wallet-bearing account without checking `verified_credentials`. Two active legacy agent API keys are also present in plaintext in the local primary dataset and are eligible for replication to Mongo snapshots.

### Finding count

| Severity | Count |
|---|---:|
| Critical | 1 |
| High | 9 |
| Medium | 8 |
| Low | 2 |
| Informational | 1 |
| **Total** | **21** |

### Top 3 most dangerous issues

1. **Cleartext authenticated mobile traffic:** the Android application globally opts into HTTP and the checked-in build configuration points at an HTTP LAN endpoint. Bearer credentials, wallet-session material, chat, and financial data are exposed to interception and modification.
2. **Deterministic on-chain email-to-wallet mapping:** anyone who knows or guesses an email can reproduce its registry key, resolve the associated wallet, and permanently monitor balances and transactions. Past on-chain mappings cannot be deleted.
3. **Authentication/account-linking weakness:** the API does not enforce Dynamic's required issuer and completed-authentication scope, then treats an unproven email claim as authority to attach a new subject to an existing account.

### Key recommendations, in priority order

1. Stop distributing the current Android build. Set release cleartext traffic to false, require a valid HTTPS API origin at build and runtime, terminate existing sessions, and rotate any credentials exposed during LAN testing.
2. Disable new on-chain email links and user-entered on-chain memo text. Replace PII-derived keys with server-resolved random identifiers or privacy-preserving credentials; plan a registry/wallet migration because existing mappings are immutable.
3. Fix Dynamic verification before the next login: require the exact issuer, a mandatory `user:basic` scope, expected token type/audience where configured, reasonable `iat`, and email proof from `verified_credentials`. Remove automatic email account attachment or gate it behind a separate re-authenticated recovery flow.
4. Revoke and rotate the two active agent keys stored in plaintext, purge `apiKeyFull` from every JSON/Mongo generation and backup, and add a startup migration that fails closed if plaintext keys reappear.
5. Put all evidence/chat media behind authenticated object IDs and participant/operator authorization; use private caching and retention/deletion jobs.
6. Suspend sending account, transaction, contact, and chat data to DeepSeek until users receive a real privacy notice, an appropriate legal basis/consent is established, a processor agreement and transfer assessment exist, and minimization/redaction is implemented.
7. Build an actual account deletion/export workflow covering primary data, media, push tokens, third-party processors, caches, and backups, with explicit exceptions for legally required financial records.

### Threat model

#### Assets and personal data

- Dynamic JWTs, Circle `userToken`/`encryptionKey`, PIN challenges, agent API keys, hot signer keys, Firebase/Pusher credentials, SMTP credentials, and Mongo connection credentials.
- Email addresses, phone numbers, handles, display names, contact books, wallet addresses, push tokens, device identifiers, chat content, uploaded photos, review evidence, payment amounts, counterparties, memos, receipts, agent spending policies, and transaction hashes.
- Consumer funds in Circle wallets, agent wallets, held-payment escrow, group pots, money circles, Gateway balances, and cross-chain jobs.

#### Trust boundaries and data flows

```text
Consumer phone
  | Dynamic bearer JWT + Circle session/challenge data + PII
  v
Hono API ---- Mongo / local JSON snapshots
  |  |  |  |---- DeepSeek (chat history, tool results, finance/profile/contact data)
  |  |  |------- Pusher / FCM (message and payment notification content)
  |  |---------- SMTP (claim and account messages)
  |------------- Circle APIs / App Kit / Gateway / external x402 sellers
  v
Arc RPC and contracts (wallet addresses, transfers, identity hashes, escrow memos)

Public Next.js pages <---- unauthenticated receipt/claim/sale/group identifiers
Public /uploads path <---- avatars, chat photos, and dispute evidence
```

The device-to-API hop, every third-party service, the local/Mongo snapshot boundary, public link possession, WebView-loaded code, external agent resources, and the Arc chain are separate trust boundaries. On-chain data must be treated as globally readable and permanent, not as an internal database.

#### Entry points and attacker profiles

- JSON bodies, query/path parameters, emails, handles, memos, chat text, uploaded images, notification payloads, and deep links.
- Dynamic bearer tokens, agent API keys, Pusher channel authorization, public receipt/claim/paywall links, and operator endpoints.
- Circle/Arc RPC responses, DeepSeek output/tool calls, FCM/Pusher events, SMTP, allowed x402 seller responses, DNS, and CDN-hosted JavaScript.
- Malicious Wi-Fi operators, phishers, credential thieves, abusive authenticated users, compromised third parties, malicious dependency/CDN publishers, insiders/log readers, and attackers with leaked marketing/email lists.

#### Privileged operations

- Creating Circle users/sessions/challenges; signing sends, swaps, bridges, deposits, withdrawals, and contract calls.
- Automated agent spending under allowance; API-key rotation; escrow claim/refund/expiry extension; registry linking/unlinking; operator dispute decisions; and admin/linker/attestor role rotation.

## 2. Findings

### Critical

#### C-01 — CWE-319: Authenticated Android traffic is sent over cleartext HTTP

**ID:** C-01 / CWE-319  
**Severity:** Critical  
**Title:** Authenticated Android traffic is sent over cleartext HTTP  
**Location:** `mobile/android/app/src/main/AndroidManifest.xml:11-15` (`<application>`); `mobile/lib/core/config/env.dart:55-95` (`resolveApiBaseUrl`, `hasInsecureApiBase`, `warnIfApiBaseUnsafe`); `mobile/lib/core/api/api_client.dart:29-39,49-99` (`_headers`, request methods); `mobile/dart_defines.json:2` (current HTTP API definition)

**Description:** The main Android manifest globally enables `android:usesCleartextTraffic="true"`. The environment helper defaults to HTTP, detects an insecure base, and merely prints a warning. It does not block a release build or request. The checked-in mobile build configuration currently supplies an HTTP LAN endpoint. Every API call adds a Dynamic bearer token and user identifier; payment flows also carry Circle session/challenge material and private financial data.

**Impact:** A person on the same Wi-Fi, a compromised router, captive portal, ISP-path attacker, or malicious hotspot can read and alter API traffic. They can steal a reusable session token, access chats and transaction history, enumerate account data, create wallet sessions/challenges, alter recipients or amounts in responses, and combine the stolen session with phishing to approve wallet actions. The attack requires no malware on the victim's phone.

**Proof of Concept / Attack Path:**

1. Victim installs the current Android build and joins a network controlled by the attacker.
2. The app connects to the configured `http://` API because the manifest explicitly permits it.
3. The attacker passively captures `Authorization: Bearer <Dynamic JWT>` or actively proxies and changes JSON responses.
4. The attacker replays the JWT against `/v1/users/me`, chat, wallet-session, held-payment, and agent endpoints until expiry. If Circle material is captured, the attacker can advance the wallet flow and present a forged confirmation context.

**Root Cause:** Development connectivity was placed in the production manifest and insecure configuration is warning-only. There is no release-mode transport invariant.

**Remediation:**

- Immediately stop distributing the APK, replace the LAN endpoint with a valid HTTPS origin, and invalidate/rotate sessions and wallet tokens used over HTTP.
- Set `usesCleartextTraffic="false"` in `src/main`; if local HTTP is unavoidable, isolate a narrowly scoped Network Security Configuration in `src/debug` only.
- Fail the release build and fail app startup when `API_BASE_URL` is not an exact HTTPS origin.
- Do not rely on certificate pinning as a substitute for TLS. If pinning is later added, include a safe rotation/backup-pin process.

```dart
static Uri apiOrigin() {
  final uri = Uri.parse(resolveApiBaseUrl());
  if (kReleaseMode &&
      (uri.scheme != 'https' || uri.host.isEmpty || uri.hasFragment)) {
    throw StateError('Release API_BASE_URL must be an exact HTTPS origin');
  }
  return uri;
}
```

**References:** [CWE-319](https://cwe.mitre.org/data/definitions/319.html), [Android cleartext communications guidance](https://developer.android.com/privacy-and-security/risks/cleartext-communications), [Android Network Security Configuration](https://developer.android.com/privacy-and-security/security-config), [OWASP Mobile Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Mobile_Application_Security_Cheat_Sheet.html)

### High

#### H-01 — CWE-287 / CWE-345: Dynamic JWT completion and issuer checks are missing, followed by unsafe email account attachment

**ID:** H-01 / CWE-287 / CWE-345  
**Severity:** High  
**Title:** Dynamic JWT completion and issuer checks are missing, followed by unsafe email account attachment  
**Location:** `server/src/services/dynamic-auth.ts:5-11,52-77` (`DynamicClaims`, `verifyInner`); `server/src/middleware/auth.ts:145-161` (`authMiddleware`); `server/src/store/db.ts:543-582` (`accountIdForSignIn`)

**Description:** JWT signature and expiration are checked, but `iss` is not validated, `aud` is not validated, `iat` is not sanity checked, and `user:basic` is required only when a scope string happens to be present. A signed token with no scope is accepted even though Dynamic explicitly says a token without `user:basic` has not completed authentication. `environment_id` is also enforced only if present. The middleware then passes the token's plain `email` claim to `accountIdForSignIn`, which silently attaches an unknown subject to an existing wallet-bearing account with that email. It does not require that the email appear as a verified email credential.

**Impact:** A valid but incomplete or wrong-purpose token can be treated as a fully authenticated consumer. If any enabled Dynamic flow can yield a signed token containing a target email without proof of that email, the attacker is attached permanently to the victim's existing account. That exposes chats, contacts, transaction history, public-link management, wallet/session creation, and account settings; it may be chained with PIN recovery or social engineering against wallet funds.

**Proof of Concept / Attack Path:** Obtain a same-environment Dynamic-signed token that omits `scope` or is not the intended access-token audience. Set or inherit a target email claim through an enabled onboarding/third-party-auth path. Submit it as a bearer token. `verifyInner` accepts it, and `accountIdForSignIn` appends the attacker's `sub` to the victim's `authIds` if the victim has a wallet.

**Root Cause:** Signature verification was treated as complete authentication, optional claims were fail-open, and account recovery/linking was coupled to an unqualified email claim.

**Remediation:** Require exact claims and separate account recovery from ordinary sign-in. Derive the expected issuer from the configured environment, require `scope` to include `user:basic`, restrict token type/audience if configured, validate `iat`, and extract email only from a matching verified credential. Do not auto-attach a new subject; require step-up proof, notify the old account, impose a cooling-off period, and provide revocation.

```ts
const expectedIssuer = `app.dynamic.xyz/${config.dynamic.environmentId}`;
const claims = jwt.verify(raw, key.getPublicKey(), {
  algorithms: ["RS256"],
  issuer: expectedIssuer,
  audience: config.dynamic.audience, // configure explicitly
  clockTolerance: 30,
}) as DynamicClaims;

const scopes = new Set((claims.scope ?? "").split(/\s+/).filter(Boolean));
if (!scopes.has("user:basic")) return null;
if (claims.environment_id !== config.dynamic.environmentId) return null;
// Resolve email from verified_credentials, not claims.email alone.
```

**References:** [Dynamic token verification requirements](https://www.dynamic.xyz/docs/react/authentication-methods/how-to-validate-users-on-the-backend), [RFC 8725 JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725), [CWE-287](https://cwe.mitre.org/data/definitions/287.html), [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

#### H-02 — CWE-532: Full Dynamic session tokens are written to mobile device logs

**ID:** H-02 / CWE-532  
**Severity:** High  
**Title:** Full Dynamic session tokens are written to mobile device logs  
**Location:** `mobile/lib/core/auth/evabob_auth.dart:475-482` (`loginWithEmailCode` failure path); related PII/stack logging at `385-387,493-499`

**Description:** When hard session establishment fails, the application interpolates both `_sdk!.auth.token` and `_sdk!.auth.minAuthToken` into `debugPrint`. This code is not guarded by `kDebugMode`; `debugPrint` is a logging API, not a release-time redaction boundary. Other paths log email, subject IDs, exception details, and stack traces.

**Impact:** A support log, adb/logcat capture, crash collector, OEM privileged app, shared development machine, or physical-device examiner can recover a bearer credential and impersonate the consumer. Dynamic itself warns that leaked JWTs can expose wallet and user data and that user JWTs must never be logged.

**Proof of Concept / Attack Path:** Trigger a timeout or inconsistent SDK state after OTP verification. Capture device logs. The failure line contains complete reusable token values. Replay one against the API.

**Root Cause:** Diagnostic logging includes secret object values and is not compiled out or redacted in release builds.

**Remediation:** Delete token logging entirely. Log only a generated correlation ID and non-sensitive state booleans; gate development diagnostics with `kDebugMode`. Add static secret-log checks and a device-log test to CI.

**References:** [Dynamic token security guidance](https://www.dynamic.xyz/docs/react/authentication-methods/how-to-validate-users-on-the-backend), [OWASP MASWE-0005](https://mas.owasp.org/MASWE/MASVS-STORAGE/MASWE-0005/), [CWE-532](https://cwe.mitre.org/data/definitions/532.html)

#### H-03 — CWE-312: Two active agent spending keys remain in plaintext and are replicated with the primary dataset

**ID:** H-03 / CWE-312  
**Severity:** High  
**Title:** Two active agent spending keys remain in plaintext and are replicated with the primary dataset  
**Location:** `server/data/evabob-db.json:1` (two active records observed; values deliberately not read into this report); `server/src/store/db.ts:178-197,320-355,1327-1334` (`AgentWallet`, `save`, `rotateAgentKey`); `server/src/services/primary-store.ts:14-29,154-178,230-247` (snapshot replication)

**Description:** New agent keys are hashed, but the schema retains the deprecated `apiKeyFull` field and only deletes it when an individual key is rotated. The audited local primary dataset contains two rows with a non-empty plaintext key and an active `apiKeyHash`. The entire JSON dataset is automatically included in the Mongo primary snapshot. Git ignores the local file, but that does not protect runtime disks, cloud snapshots, backups, support bundles, or insiders.

**Impact:** Anyone who reads one snapshot obtains a live credential for automated USDC spending within that agent's allowance and service policy. Theft can be repeated until the owner notices and revokes the key; a backup leak remains useful even after application code stops displaying keys.

**Proof of Concept / Attack Path:** Read an old/current `evabob-db.json` or Mongo primary snapshot, extract `apiKeyFull`, and authenticate to agent API/x402 routes. The API recognizes the corresponding active hash and attributes spending to the owner.

**Root Cause:** The migration changed issuance behavior but did not rotate or scrub legacy credentials across active state and historical generations.

**Remediation:** Immediately revoke and rotate every record that ever contained `apiKeyFull`; do not merely delete the plaintext while preserving the same live key. Purge the field from current Mongo/JSON state, old primary-store generations, logs, local copies, and backups according to a documented incident procedure. Add a startup assertion/migration and CI fixture scan that refuses a non-empty plaintext-key field.

**References:** [CWE-312](https://cwe.mitre.org/data/definitions/312.html), [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html), [OWASP MASVS Storage](https://mas.owasp.org/MASVS/05-MASVS-STORAGE/)

#### H-04 — CWE-284 / CWE-200: Private chat and dispute photos are unauthenticated public objects

**ID:** H-04 / CWE-284 / CWE-200  
**Severity:** High  
**Title:** Private chat and dispute photos are unauthenticated public objects  
**Location:** `server/src/index.ts:127-149,191-233` (request logger and `/uploads/:file`); `server/src/services/evidence.ts:17-36` (`storePhoto`); `server/src/services/mongo.ts:348-383` (shared `avatars` collection); `server/src/routes/api.ts:1141-1160,1196-1234,2812-2841` (review/chat uploads)

**Description:** Review evidence and chat photos use random filenames but are served to any unauthenticated caller. There is no participant/operator ACL, expiry, revocation, or deletion. Responses explicitly allow public caching for 24 hours. Every GET also writes the full capability-bearing path to console and `http.jsonl`. Review-message routes store photos before `addReviewMessage` verifies the caller's role, allowing unauthorized authenticated callers who know a transfer ID to create orphaned sensitive objects.

**Impact:** Photos may contain faces, homes, addresses, parcels, receipts, private conversations, or evidence of disputes. A leaked URL from logs, notifications, screenshots, analytics, proxies, or one participant remains usable by anyone and may be cached outside Evabob's control. Log readers gain direct access without account authorization. Orphan uploads increase retained sensitive material and storage abuse.

**Proof of Concept / Attack Path:** Obtain or observe `/uploads/chatphoto_<token>.jpg` or `/uploads/evidence_<token>.jpg`, then fetch it without a bearer token. The server returns the bytes with public caching. For review uploads, submit photos against a guessed/known transfer ID as a non-party; storage occurs before role validation even if the message operation later fails.

**Root Cause:** Random names were treated as authorization, media metadata was not modeled with owners/participants, and storage was performed before authorization.

**Remediation:** Store an opaque media ID plus owner/thread/review ACL and retention timestamp. Serve through an authenticated route that authorizes the current user, or issue short-lived signed object-store URLs after authorization. Use `Cache-Control: private, no-store` for evidence. Redact capability IDs from logs. Validate role before decoding/storing bytes. Add deletion jobs for chat deletion, review closure, and account erasure.

**References:** [CWE-284](https://cwe.mitre.org/data/definitions/284.html), [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)

#### H-05 — CWE-829: Runtime CDN JavaScript receives wallet authentication secrets and controls PIN challenges

**ID:** H-05 / CWE-829  
**Severity:** High  
**Title:** Runtime CDN JavaScript receives wallet authentication secrets and controls PIN challenges  
**Location:** `mobile/assets/challenge.html:87,480-483`; `mobile/lib/features/wallet/circle_challenge_screen.dart:59,71-79,98-105,108-123,154-199,353-386` (`_authPayload`, `_embedAuth`, `_boot`, `_fallbackHtml`)

**Description:** The wallet confirmation WebView dynamically imports Circle's Web SDK from jsDelivr at runtime. The page then receives the Circle `userToken`, `encryptionKey`, challenge IDs, unrestricted JavaScript, third-party cookies, and a bridge back to Flutter. Main-frame navigation is constrained, but subframe navigation is accepted and there is no content-integrity mechanism for the ESM import. The HTML is assigned the synthetic trusted origin `https://evabob.app/_circle-challenge/`. Circle's official package instructions use a locally installed/bundled package, not a runtime CDN import.

**Impact:** Compromise of the npm release, jsDelivr, its build pipeline, DNS/TLS trust, or an upstream dependency executes attacker code inside the most privileged client page. It can exfiltrate wallet session material, phish or alter the PIN UI, substitute challenge handling, or steal typed-data signatures. This is a high-scale supply-chain route to consumer funds.

**Proof of Concept / Attack Path:** If the CDN response for the pinned URL is replaced, the malicious module reads `window.__EVABOB_CHALLENGE__`, sends the token/key/challenge IDs to an attacker, renders a counterfeit PIN prompt, and returns a plausible success payload through `EvabobBridge`.

**Root Cause:** A development workaround loads privileged wallet code from a mutable remote origin rather than bundling a reviewed artifact into the signed application.

**Remediation:** Use Circle's native mobile SDK or bundle an audited, locked Web SDK and its transitive dependencies into the application. Verify the artifact hash in CI, remove runtime module imports, give the WebView a narrowly scoped local origin, allowlist every subresource/navigation origin, disable debugging in release, and add a restrictive CSP. Do not embed the secrets until the locally trusted code is loaded and attested as expected.

**References:** [CWE-829](https://cwe.mitre.org/data/definitions/829.html), [Circle Web SDK repository and npm installation](https://github.com/circlefin/w3s-pw-web-sdk), [OWASP Third Party JavaScript Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_JavaScript_Management_Cheat_Sheet.html)

#### H-06 — PRIV-CHAIN-001 / CWE-759: Deterministic hashes expose email-to-wallet identity on Arc

**ID:** H-06 / PRIV-CHAIN-001 / CWE-759  
**Severity:** High  
**Title:** Deterministic hashes expose email-to-wallet identity on Arc  
**Location:** `contracts/src/IdentityRegistryV3.sol:14-29,40-41,69-85,95-110` (`identityKey`, `resolveIdentifier`, `adminLink`); `server/src/services/identity.ts:9-21,49-55` (`normalizeIdentifier`, `computeIdentityKey`); `server/src/services/protectedEscrow.ts:85-109` (`escrowRecipientKey`)

**Description:** The registry key is `keccak256(uint8(idType) || normalizedIdentifier)` with no secret salt. Email addresses have low entropy and are normally known to counterparties, data brokers, phishers, employers, and breached-list operators. Anyone can compute the same key locally, call `resolve`, and obtain the linked account. The public `IdentityLinked` event makes bulk monitoring easier. Calling the value a hash does not make it anonymous or pseudonymous against a dictionary attack.

**Impact:** Attackers can map consumer emails to wallet addresses at scale, inspect balances and full public transaction graphs, target wealthy users, correlate employers/families/merchants, and build phishing or extortion lists. Unlinking only flips `active`; historic events and the old account remain permanently visible. This is an irreversible privacy disclosure.

**Proof of Concept / Attack Path:** Normalize a target email exactly as the app does, calculate the keccak key with the Email enum value, query `resolve(key)`, then feed the returned address to an Arc explorer/indexer. Repeat for a breached email list.

**Root Cause:** Unsalted deterministic hashing was used as a privacy boundary while also requiring arbitrary senders to derive the recipient key.

**Remediation:** Stop creating new email-derived on-chain keys. Resolve verified emails off-chain and return a random opaque recipient identifier or use a privacy-preserving credential/commitment scheme designed for public ledgers. Do not place a reusable salt next to the hash on-chain. Deploy a new registry, rotate affected mappings/wallets where feasible, remove email lookup from the old flow, and notify users that historic associations cannot be erased from Arc.

**References:** [CWE-759](https://cwe.mitre.org/data/definitions/759.html), [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html), [GDPR Recital 26 (identifiability)](https://eur-lex.europa.eu/eli/reg/2016/679/oj)

#### H-07 — PRIV-CHAIN-002: Consumer memo and milestone text is published permanently on-chain without an effective warning

**ID:** H-07 / PRIV-CHAIN-002  
**Severity:** High  
**Title:** Consumer memo and milestone text is published permanently on-chain without an effective warning  
**Location:** `contracts/src/PaymentEscrowV3.sol:52-62,145-171` (`Transfer`, `TransferCreated`, `createTransfer`); `contracts/src/EvabobMemo.sol:26-40,48-59` (`record`, `Memo`); `server/src/services/protectedEscrow.ts:131-171,252-275` (`planProtectedEscrow`, `planMilestoneHolds`); `server/src/services/memo.ts:13-22,90-128`; `mobile/lib/features/send/send_screen.dart:343-356,796-814` (review and memo input)

**Description:** `PaymentEscrowV3` stores the full memo string in public contract storage and emits it in `TransferCreated`. Milestone descriptions are converted into those memos. An optional `EvabobMemo` contract similarly emits memo bytes forever for direct sends when enabled. The source comments claim the app warns users, but the reviewed send UI labels the field only “Add a memo (optional)” and repeats the memo on review; it does not state that held-payment text is globally public and irreversible. The optional direct-memo contract is disabled in the audited local environment, but escrow memo publication is inherent in the contract.

**Impact:** Users will naturally enter invoice details, medical/family reasons, addresses, order descriptions, or names. Those details become permanently associated with payer/contract activity and cannot be deleted, corrected, or meaningfully withdrawn. This can cause doxxing, profiling, safety risk, and regulatory exposure.

**Proof of Concept / Attack Path:** Create a held payment with a unique memo or milestone description. Read the `TransferCreated` event or the public `transfers(id).memo` field from any Arc RPC endpoint without authenticating to Evabob.

**Root Cause:** Product data was modeled as ordinary database text even though the destination is a permanent public ledger, and a code comment substituted for an enforced UX/privacy control.

**Remediation:** Never put user-entered free text on-chain. Store only a random reference or keyed commitment; keep the text in an access-controlled, encrypted, retention-limited service. If public text is an explicit optional feature, require a separate opt-in confirmation with concrete examples and no preselected consent. Deploy a new escrow version without `string memo`; existing events cannot be removed.

**References:** [CWE-359](https://cwe.mitre.org/data/definitions/359.html), [OWASP MAS-P Baseline Privacy](https://mas.owasp.org/Profiles/MAS-P/), [GDPR Article 5 data minimization](https://eur-lex.europa.eu/eli/reg/2016/679/oj)

#### H-08 — PRIV-THIRD-PARTY-001: Financial, identity, contact, and chat data is disclosed to DeepSeek without user-facing notice or minimization

**ID:** H-08 / PRIV-THIRD-PARTY-001  
**Severity:** High  
**Title:** Financial, identity, contact, and chat data is disclosed to DeepSeek without user-facing notice or minimization  
**Location:** `server/src/services/agentChat.ts:40-64,101-178` (`runAgentTurn`); `server/src/services/agentLlm.ts:146-180` (`refineAgentIntent`); `server/src/services/agentTools.ts:200-247,440-515` (`get_activity`, receive details, `get_contacts`, `get_profile`); `server/src/services/llm.ts:60-100` (`chatCompletion`); `mobile/lib/features/auth/login_screen.dart:225-229`; `mobile/lib/features/profile/profile_screen.dart:163-173`

**Description:** Up to eight recent messages and the current message are sent to DeepSeek. When the model calls tools, subsequent requests include results containing transaction amounts, counterparties, timestamps, wallet addresses, emails, contacts, profile data, and agent balances. There is no redaction layer, per-field allowlist, consent/opt-out, visible subprocessor disclosure, or accessible privacy notice. DeepSeek's current open-platform terms place disclosure, legal-basis, and data-subject-rights duties on the downstream developer; its privacy material states that input/personal data may be processed in China and retained according to purpose/legal needs.

**Impact:** Consumers may disclose their own and third parties' financial and communications data to an external processor without understanding it. A provider incident, government request, retention/training policy, or cross-border-transfer failure can expose a large corpus of sensitive financial relationships. Contacts did not consent to have their names/addresses sent to the model.

**Proof of Concept / Attack Path:** Ask the assistant “show my recent payments and who I can pay.” The model calls `get_activity`, `get_contacts`, and/or `get_profile`; their raw outputs are appended as tool messages and posted to the configured DeepSeek endpoint.

**Root Cause:** The LLM was treated as an internal function instead of a separate data recipient/processor, and tool output was optimized for usefulness rather than minimization.

**Remediation:** Suspend sensitive tools until a DPIA/data map, processor agreement, cross-border transfer mechanism, retention/training controls, and user-facing notice/legal basis are complete. Send the minimum fields necessary; replace names/emails/addresses/hashes with turn-scoped aliases; keep contact and exact-transaction tools local when possible; provide an explicit opt-out and non-LLM fallback; implement deletion propagation and audit logs that contain no prompt data.

**References:** [DeepSeek Open Platform Terms](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html), [DeepSeek Privacy Policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html), [GDPR Articles 5, 13, 28 and 44](https://eur-lex.europa.eu/eli/reg/2016/679/oj), [OWASP LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)

#### H-09 — PRIV-ERASURE-001: Account deletion and privacy notice are non-functional and misleading

**ID:** H-09 / PRIV-ERASURE-001  
**Severity:** High  
**Title:** Account deletion and privacy notice are non-functional and misleading  
**Location:** `mobile/lib/features/profile/profile_screen.dart:163-173,195-288` (`_showTerms`, `_showDeleteAccount`); `mobile/lib/features/auth/login_screen.dart:225-229`; no deletion/erasure endpoint exists under `server/src/routes/`; retained data types are defined at `server/src/store/db.ts:83-205` and media at `server/src/services/mongo.ts:348-383`

**Description:** The UI states that profile, chats, and Evabob history “will be removed,” but the destructive button only closes the sheet and shows a snackbar saying support handles deletion. It does not create a request or open a support channel. The “Terms” view is two short sentences, and the login agreement text is not linked to Terms or a Privacy Notice. There is no server-side account deletion/export/retention workflow for users, messages, contacts, photos, push devices, LLM disclosures, or primary-store generations.

**Impact:** Consumers cannot exercise deletion/access rights, cannot learn what is collected or shared, and may be deceived into believing deletion has started. Sensitive data and capability URLs persist indefinitely. GDPR/CCPA exposure is amplified because the product processes financial and communications data and sends data to multiple processors.

**Proof of Concept / Attack Path:** Tap Profile → Delete account → Continue with support. No API call, ticket, navigation, tombstone, or deletion occurs. Sign back in and all data remains.

**Root Cause:** Design frames were implemented without the underlying privacy operations, retention model, legal copy, or processor-deletion orchestration.

**Remediation:** Implement authenticated export and deletion requests with step-up verification, status tracking, cooling-off/reversal where appropriate, and precise treatment of wallet/on-chain/legal-retention exceptions. Delete or irreversibly anonymize chats, contacts, device tokens, media, model data, and inactive identity links; schedule backup expiry. Publish accessible Terms and Privacy Notice before collection, naming purposes, categories, processors, transfers, retention, rights, and contact details. Change the UI immediately so it does not claim deletion until the workflow exists.

**References:** [GDPR Articles 12, 13 and 17](https://eur-lex.europa.eu/eli/reg/2016/679/oj), [California DOJ CCPA guidance](https://www.oag.ca.gov/privacy/ccpa), [OWASP MAS-P](https://mas.owasp.org/Profiles/MAS-P/)

### Medium

#### M-01 — CWE-307 / CWE-916: App-lock PIN is cheaply brute-forced, unthrottled, and fails open

**ID:** M-01 / CWE-307 / CWE-916  
**Severity:** Medium  
**Title:** App-lock PIN is cheaply brute-forced, unthrottled, and fails open  
**Location:** `mobile/lib/core/security/app_lock_service.dart:36-61,64-84,107-145` (`init`, `_hashPin`, `setPin`, `unlockWithPin`, `unlockWithBiometrics`); `mobile/lib/features/auth/app_lock_screen.dart:141-209` (`_showForgotPin`)

**Description:** A 4-character PIN is accepted, hashed once with SHA-256 and a timestamp-derived salt, and compared without any attempt counter, exponential backoff, device-keystore rate limiting, or wipe/re-authentication threshold. Missing secure-storage state silently disables the lock or unlocks it. “Biometrics” uses `biometricOnly: false`, so a device credential may satisfy the prompt despite copy implying fingerprint/face.

**Impact:** A stolen unlocked/rooted device, extracted secure-storage backup, instrumentation hook, or unattended phone allows rapid offline or online guessing of the app lock and exposure of chats and financial data. The control gives consumers more confidence than protection.

**Proof of Concept / Attack Path:** Enter all 10,000 four-digit values; there is no delay or lockout. If the hash/salt are extracted, compute one SHA-256 per candidate. Removing/corrupting the stored hash causes a fail-open path.

**Root Cause:** A convenience PIN was implemented as a local hash rather than a hardware-backed, rate-limited authentication control.

**Remediation:** Prefer platform device authentication with `biometricOnly` matching the UI and a documented device-credential fallback. If an app PIN remains, require at least six digits, use Argon2id/scrypt with a random CSPRNG salt, compare in constant time, enforce persisted exponential backoff and a hard attempt threshold, and fail closed into full account re-authentication when storage is inconsistent.

**References:** [CWE-307](https://cwe.mitre.org/data/definitions/307.html), [CWE-916](https://cwe.mitre.org/data/definitions/916.html), [OWASP Mobile Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Mobile_Application_Security_Cheat_Sheet.html)

#### M-02 — CWE-1104: Production server dependency tree contains known high-severity advisories and an Android SDK uses a floating version

**ID:** M-02 / CWE-1104  
**Severity:** Medium  
**Title:** Production server dependency tree contains known high-severity advisories and an Android SDK uses a floating version  
**Location:** `server/package.json:23-28`; `server/package-lock.json` (resolved graph); `mobile/android/app/build.gradle.kts:85`

**Description:** `npm audit --omit=dev` reports 27 production findings: 11 high, 9 moderate, and 7 low. The high paths are aggregated through the Circle/App Kit graph and include `toml@3.0.0` prototype-pollution/uncontrolled-recursion advisories; moderate paths include `stream-json@1.9.1` DoS and `uuid@8.3.2`. Circle packages are imported on live wallet, bridge, swap, Gateway, and agent paths, so this is not a dev-only tree. Some individual vulnerable parsers may not currently receive attacker-controlled input; exploitability requires call-path testing. The Android build also resolves `circle.programmablewallet:sdk:1.0.+`, allowing an unreviewed future artifact to enter builds.

**Impact:** A reachable parsing flaw can crash the API or alter application objects; a compromised or unexpectedly changed transitive release can affect every wallet operation at build/deploy scale. Floating mobile dependencies make builds non-reproducible and weaken incident response.

**Proof of Concept / Attack Path:** Run `npm audit --omit=dev --json` in `server/`. Observe the advisory paths through `@circle-fin/app-kit`, adapters, `@coral-xyz/anchor`, and `@solana/web3.js`. Rebuild Android on different dates and `1.0.+` may resolve different SDK artifacts.

**Root Cause:** Large all-in-one SDK graphs were accepted without an advisory gate/reachability exception process, and the native dependency is not pinned.

**Remediation:** Pin the exact Android SDK version and verify checksums. Work with Circle on patched dependency releases; upgrade only after money-flow regression tests. Remove unused adapters/chains to shrink the graph. Add SBOM generation, Dependabot/Renovate, `npm audit --omit=dev` policy with documented reachability exceptions and expiry dates, and artifact signing/provenance checks. Do not apply a forced major downgrade blindly.

**References:** [GHSA-82x6-q7mm-w9cf](https://github.com/advisories/GHSA-82x6-q7mm-w9cf), [GHSA-v5mp-jgw5-2x6j](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j), [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x), [OWASP Software Supply Chain Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.html)

#### M-03 — MOB-LINK-001: Custom-scheme payment/deep links can be hijacked by another mobile app

**ID:** M-03 / MOB-LINK-001  
**Severity:** Medium  
**Title:** Custom-scheme payment/deep links can be hijacked by another mobile app  
**Location:** `mobile/android/app/src/main/AndroidManifest.xml:30-40`; `mobile/ios/Runner/Info.plist:65-73`; `mobile/lib/core/navigation/app_link_service.dart:16-33`; `mobile/lib/features/shell/app_shell.dart:81-169`

**Description:** Android and iOS accept the unverified `evabob://` scheme. Android declares no verified HTTPS App Link and no host/path restrictions. The app-link service checks only the scheme; the shell interprets host/path/query data as payment, claim, held-payment, task, agent, and operator-review navigation. Any installed app can register the same custom scheme, and phishing pages can launch arbitrary internal routes.

**Impact:** Malware can intercept legitimate claim/payment links or present a counterfeit Evabob flow; attackers can force victims into attacker-selected payment/request screens and use trusted app chrome to strengthen social engineering. Backend authorization prevents some direct privilege escalation, but it does not prevent interception or confused-user payment approval.

**Proof of Concept / Attack Path:** Install a second Android app with an `evabob` VIEW intent filter. Tap an Evabob link; the OS can route or offer it to the attacker app. Conversely, open `evabob://pay/<attacker-id>` from a phishing page to push the real app into an attacker-chosen flow.

**Root Cause:** Custom schemes were used as an identity/authenticity boundary instead of verified domain associations and strict route validation.

**Remediation:** Use `https://evabob.app/...` Android App Links with `android:autoVerify="true"` plus `/.well-known/assetlinks.json`, and iOS Universal Links with `apple-app-site-association`. Constrain paths, validate identifier syntax and action allowlists, reject unexpected parameters, and always show trusted recipient/amount fetched from the server before confirmation.

**References:** [Android unsafe deep links](https://developer.android.com/privacy-and-security/risks/unsafe-use-of-deeplinks), [Android App Links](https://developer.android.com/training/app-links/about), [OWASP MASVS Platform Interaction](https://mas.owasp.org/MASVS/06-MASVS-PLATFORM/)

#### M-04 — PRIV-NOTIFY-001: Lock-screen notifications disclose payment, chat, and commercial details by default

**ID:** M-04 / PRIV-NOTIFY-001  
**Severity:** Medium  
**Title:** Lock-screen notifications disclose payment, chat, and commercial details by default  
**Location:** `server/src/services/notifyUser.ts:75-93,104-124` (`UserAlert`, `alertUser`); `server/src/services/push.ts:192-218` (`fcmMessage`); `server/src/routes/api.ts:2861-2873` (`announceChatMessage`); representative financial bodies at `server/src/routes/api.ts:1755-1758,1801-1804` and `server/src/services/agentControls.ts:190-193`; `mobile/lib/core/notifications/push_registration.dart:75-109`

**Description:** Push payloads include message previews, counterparty names, exact amounts, invoice descriptions, task titles, agent spending requests, and dispute status. Android notification visibility is not set to private/secret, and APNs receives an alert body with default preview behavior. Permission is requested automatically during registration rather than after a privacy choice about preview detail.

**Impact:** Anyone near a locked phone, workplace device-management software, notification-sync service, car display, watch, or shared device can read private messages and financial relationships without unlocking Evabob.

**Proof of Concept / Attack Path:** Lock the phone, send a chat message or payment request containing sensitive text, and observe the full body on the lock screen.

**Root Cause:** The same rich in-app alert object is reused as an OS notification payload with no lock-screen privacy classification or user preference.

**Remediation:** Default to generic text such as “You have a new Evabob notification,” place detail only in authenticated in-app views, set Android visibility to private and a redacted public version, and offer an explicit “show amounts/message previews” setting. Request notification permission contextually after explaining the privacy choice.

**References:** [OWASP MAS-P](https://mas.owasp.org/Profiles/MAS-P/), [OWASP MASTG notifications test index](https://mas.owasp.org/MASTG/tests/), [CWE-359](https://cwe.mitre.org/data/definitions/359.html)

#### M-05 — CWE-203: Any authenticated user can enumerate private email membership and create unsolicited threads

**ID:** M-05 / CWE-203  
**Severity:** Medium  
**Title:** Any authenticated user can enumerate private email membership and create unsolicited threads  
**Location:** `server/src/routes/api.ts:3308-3347` (`POST /chat/threads`)

**Description:** The route accepts an email or handle, queries users, and returns a distinct `USER_NOT_FOUND` response that includes the normalized identifier. A successful lookup creates a chat thread immediately. There is no privacy setting, consent/request state, block list, or email-specific anti-enumeration response. The broad rate limit permits 300 attempts/minute per effective source.

**Impact:** Attackers can test breached/marketing email lists for Evabob membership, correlate identity with a crypto-payment product, and create harassment/spam threads. Membership in a financial app is personal information.

**Proof of Concept / Attack Path:** Authenticate one account, submit candidate emails to `/v1/chat/threads`, and classify 404 versus 200. Repeat across distributed accounts/IPs.

**Root Cause:** A user-discovery feature exposes a private identifier and couples lookup to thread creation.

**Remediation:** Do not expose email membership. Use invite-based discovery, privacy-controlled handles, or a server-mediated request that returns the same response regardless of membership. Add abuse detection, account-age limits, per-target throttles, block/report controls, and recipient acceptance before creating a usable thread.

**References:** [CWE-203](https://cwe.mitre.org/data/definitions/203.html), [OWASP Authentication Cheat Sheet — discrepancy factors](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

#### M-06 — PRIV-LINK-001: Public financial receipt links cannot expire or be revoked

**ID:** M-06 / PRIV-LINK-001  
**Severity:** Medium  
**Title:** Public financial receipt links cannot expire or be revoked  
**Location:** `server/src/services/publicReceipts.ts:47-74,143-185` (`newPublicId`, `sharePayment`, `publicReceipt`); `server/src/store/db.ts:959-961` (`findActivityByPublicId`); `server/src/routes/api.ts:464-474`; `src/app/r/[publicId]/page.tsx:86-126`

**Description:** Receipt IDs have good entropy and sharing is owner-only, but once generated the same public ID remains on the activity record indefinitely. There is no unshare, rotation, expiry, audience restriction, or deletion path. Anyone possessing the URL sees amount, token, payer/payee labels, time, stage, and often transaction hash/explorer link without authentication.

**Impact:** A receipt pasted into the wrong chat, indexed by a messaging/link-preview provider, captured in browser history, or leaked from a device remains a permanent public window into the consumer's payment relationship.

**Proof of Concept / Attack Path:** Share a completed receipt, copy the URL, log out, and open it in a private browser. The data remains available. There is no API/UI action that invalidates the ID.

**Root Cause:** Possession links were designed for authenticity but not lifecycle control or privacy recovery.

**Remediation:** Add owner-authenticated revoke/rotate actions, optional short expiry, a minimal default view, `robots`/`noindex`, `Referrer-Policy: no-referrer`, and audit visibility for link access. Ensure account erasure revokes off-chain views even though the underlying chain transaction remains public.

**References:** [OWASP Forgot Password Cheat Sheet — URL token lifecycle principles](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), [CWE-359](https://cwe.mitre.org/data/definitions/359.html)

#### M-07 — CWE-307 / CWE-770: Rate limiting is instance-local and the general limiter runs before identity resolution

**ID:** M-07 / CWE-307 / CWE-770  
**Severity:** Medium  
**Title:** Rate limiting is instance-local and the general limiter runs before identity resolution  
**Location:** `server/src/middleware/rate-limit.ts:9-12,29-87,90-112` (`callerKey`, `rateLimit`); `server/src/index.ts:152-180` (middleware ordering)

**Description:** Buckets are in-memory and per process. The general limiter runs before authentication, so `c.get("auth")` is always absent there and all callers are keyed by socket peer address. Behind a reverse proxy that peer may be the proxy, allowing one client to exhaust a shared 300-request bucket for all consumers; across multiple app instances an attacker multiplies the effective limit. There is no trusted-proxy parsing or shared atomic counter.

**Impact:** An attacker can cause broad login/payment/chat outages or bypass limits on expensive and privacy-sensitive endpoints by distributing requests across instances/IPs. Consumer users will see money flows as broken or stuck.

**Proof of Concept / Attack Path:** Through a deployment proxy, issue 301 `/v1` requests within a minute and observe unrelated users behind the same peer bucket receive 429. In a multi-instance deployment, alternate instances to obtain each instance's allowance.

**Root Cause:** A single-instance development limiter was retained at a production trust boundary, and middleware ordering conflicts with the code's authenticated-user preference.

**Remediation:** Use a shared Redis/managed atomic limiter with keys for authenticated account, agent key, device/session, target resource, and validated client IP. Configure trusted proxy hops explicitly. Apply a small pre-auth IP/device ceiling and a separate post-auth user ceiling; add global circuit breakers for Circle, SMTP, LLM, and RPC cost.

**References:** [CWE-307](https://cwe.mitre.org/data/definitions/307.html), [CWE-770](https://cwe.mitre.org/data/definitions/770.html), [OWASP Denial of Service Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html)

#### M-08 — CWE-1021: Public Next.js payment pages lack baseline browser security headers

**ID:** M-08 / CWE-1021  
**Severity:** Medium  
**Title:** Public Next.js payment pages lack baseline browser security headers  
**Location:** `next.config.mjs:1-5`; public financial routes under `src/app/r/[publicId]/`, `src/app/pay/`, `src/app/claim/`, `src/app/h/`, `src/app/g/`, `src/app/task/`, and `src/app/x/`

**Description:** The API installs strong Hono headers, but the separate Next.js app defines none. There is no CSP, `frame-ancestors`/`X-Frame-Options`, HSTS, Referrer-Policy, Permissions-Policy, or explicit `nosniff`. These pages are payment/claim/share surfaces that are attractive for clickjacking and lookalike embedding. The installed Next 16 documentation supports `headers()` and recommends CSP for XSS/clickjacking mitigation.

**Impact:** A hostile site can iframe a legitimate Evabob page and visually overlay controls, leak capability URLs through referrers, or gain more leverage from any future injection. This strengthens consumer payment phishing even where a later PIN is required.

**Proof of Concept / Attack Path:** Host an attacker page containing an iframe to a public receipt/payment URL; absent deployment-layer protection, the browser is not instructed to block framing.

**Root Cause:** Security headers were configured for the API process only, not the public Next.js deployment.

**Remediation:** Add a tested Next 16 `headers()` policy for every route: HSTS in HTTPS production, `Content-Security-Policy` with `frame-ancestors 'none'`, `object-src 'none'`, restrictive `base-uri`/`form-action`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, and `X-Content-Type-Options: nosniff`. Start CSP in report-only mode and use the installed Next nonce guidance if inline scripts require it.

**References:** [Installed Next.js headers guidance](node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md), [Installed Next.js CSP guidance](node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md), [CWE-1021](https://cwe.mitre.org/data/definitions/1021.html), [OWASP Clickjacking Defense Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html)

### Low

#### L-01 — CWE-250 / PRIV-PERM-001: Mobile permissions and platform disclosures exceed or misstate actual use

**ID:** L-01 / CWE-250 / PRIV-PERM-001  
**Severity:** Low  
**Title:** Mobile permissions and platform disclosures exceed or misstate actual use  
**Location:** `mobile/android/app/src/main/AndroidManifest.xml:2-9`; `mobile/lib/core/contacts/device_contacts.dart:26-45`; `mobile/ios/Runner/Info.plist:74-81`

**Description:** Android requests `WRITE_CONTACTS`, but the app only requests read permission and reads contacts. iOS says photo-library access is for profile pictures even though chat/review evidence also uses photos, and says camera access is for wallet QR codes despite chat/evidence capture. Face ID copy says it confirms payments while the reviewed app-lock call permits device credentials and Circle PIN handles payment approval.

**Impact:** Unnecessary permission surface and inaccurate purpose strings reduce trust, can fail app-store privacy review, and cause consumers to consent without an accurate understanding of use.

**Proof of Concept / Attack Path:** Inspect requested permissions/purpose strings, then exercise photo attachment and biometric flows; observed purposes exceed the disclosed text, while no contact write operation exists.

**Root Cause:** Manifest/plist entries were not updated as features changed and permissions were not minimized.

**Remediation:** Remove `WRITE_CONTACTS`; request only read access at the moment the picker is used. Rewrite purpose strings to enumerate actual uses in plain language. Keep app-store privacy labels and the product privacy notice synchronized through release checks.

**References:** [OWASP MAS-P](https://mas.owasp.org/Profiles/MAS-P/), [Android permissions best practices](https://developer.android.com/training/permissions/usage-notes), [CWE-250](https://cwe.mitre.org/data/definitions/250.html)

#### L-02 — CWE-532: Operational logs contain consumer identifiers and capability-bearing paths

**ID:** L-02 / CWE-532  
**Severity:** Low  
**Title:** Operational logs contain consumer identifiers and capability-bearing paths  
**Location:** `server/src/store/db.ts:563-582` (`accountIdForSignIn`); `server/src/index.ts:127-149` (HTTP logger); `server/src/services/notifyUser.ts:121-129` (`alertUser` failure logging)

**Description:** New-subject linking logs the full email and account ID. The HTTP logger records complete paths, including public receipt IDs, upload capabilities, transfer IDs, and other share tokens. Notification failures log internal user IDs. User IDs are pseudonymized only in one field, not in the path or other subsystem logs.

**Impact:** Log aggregation, support access, backups, or an observability breach can correlate consumers and expose capability URLs. The upload-path aspect materially amplifies H-04.

**Proof of Concept / Attack Path:** Sign in with a new Dynamic subject for an existing email, or request an upload/public link; inspect console/`http.jsonl` and observe identifiers or bearer-style path tokens.

**Root Cause:** Logging redaction is field-specific and does not classify email or URL path segments as sensitive.

**Remediation:** Use structured event names and opaque request IDs. Hash or tokenize user identifiers with a rotating keyed HMAC, never log email, and replace sensitive path segments with route templates before logging. Define retention/access controls and test logs for secrets/PII.

**References:** [CWE-532](https://cwe.mitre.org/data/definitions/532.html), [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), [OWASP MASTG logging guidance](https://mas.owasp.org/MASTG/knowledge/android/MASVS-STORAGE/MASTG-KNOW-0049/)

### Informational

#### I-01 — AUDIT-LIMIT-001: Smart-contract toolchain and production controls were not independently executable from this workstation

**ID:** I-01 / AUDIT-LIMIT-001  
**Severity:** Info  
**Title:** Smart-contract toolchain and production controls were not independently executable from this workstation  
**Location:** `contracts/src/PaymentEscrowV3.sol`, `IdentityRegistryV3.sol`, `GroupPots.sol`, `MoneyCircles.sol`, `EvabobMemo.sol`; deployment/runtime configuration external to the repository

**Description:** Source review found state-before-transfer updates, reentrancy guards where loops/transfers require them, bounded fees/durations, and role separation, but `forge` and `slither` are not installed on this workstation, so Foundry tests, fuzzing, invariant testing, and static analyzers could not be rerun. Live contract bytecode, proxy/admin state, Safe ownership, key custody, cloud access controls, TLS termination, Mongo encryption/backups, Dynamic settings, Circle console settings, FCM/APNs settings, and production logs were not independently verified.

**Impact:** Source that looks correct can still be deployed with different bytecode, unsafe roles, compromised keys, or broken operational controls. Contract failures are irreversible and may strand funds.

**Proof of Concept / Attack Path:** `forge test` fails because `forge` is unavailable. No conclusion about deployed bytecode equivalence or live-role custody can be drawn from repository source alone.

**Root Cause:** This is an audit coverage limitation, not a code defect.

**Remediation:** Run pinned Foundry tests and Slither in CI; add invariant/fuzz tests for conservation of funds, claim/refund races, circle debt accounting, malicious/non-standard token behavior, and role compromise. Verify deployed bytecode against tagged source, publish addresses, monitor role changes, and have an independent contract auditor review before mainnet value is accepted.

**References:** [Foundry invariant testing](https://book.getfoundry.sh/forge/invariant-testing), [Slither](https://github.com/crytic/slither), [OWASP Smart Contract Top 10](https://owasp.org/www-project-smart-contract-top-10/)

## 3. Positive Observations

- The API installs HSTS, `no-referrer`, frame denial, and `nosniff` headers at `server/src/index.ts:50-55`.
- Hosted-environment startup fails closed when header authentication is enabled, origins are wildcard/non-HTTPS, Mongo is absent, public origins are insecure, or hot keys are missing/reused (`server/src/services/production-safety.ts:31-73`).
- Agent/x402 outbound HTTP has a real SSRF boundary: exact HTTPS-origin allowlists, no IP literals, public-IPv4 checks during the actual socket lookup (resisting DNS rebinding), no redirects, a 1 MiB cap, and a timeout (`server/src/services/safe-agent-http.ts:5-80`).
- New agent API keys are high-entropy, stored as hashes, shown once, and removed from plaintext on rotation. The legacy migration failure is the exception identified in H-03.
- Pusher private channels and API resources derive identity from verified middleware rather than trusting client-supplied sender IDs. Chat photo upload checks thread membership before storage; the review route should follow the same ordering.
- The agent model cannot directly execute a payment. Tool context is server-derived, money tools produce proposals, confirmation copy is reconstructed from validated proposal data rather than model prose, and PIN approval remains required (`server/src/services/agentChat.ts:14-18`, `server/src/routes/agent.ts:436-496`). The system prompt also correctly treats tool-returned text as untrusted data.
- Payment confirmation paths re-read and verify on-chain receipts instead of trusting a client-supplied “completed” status. Idempotency and duplicate-receipt controls are present in key flows.
- Escrow V3 limits the attestor: claims resolve through the registry, early refunds can only return money to the original sender, and expiry extension is bounded. Admin/linker/attestor roles are separated in source.
- `GroupPots` and `MoneyCircles` use state transitions and reentrancy guards around external token transfers, bound group size/duration/fees, and do not expose an admin withdrawal path in the reviewed source.
- Upload code validates decoded image type/size and uses 128-bit random filenames. Those controls are useful defense-in-depth once authorization and lifecycle are fixed.
- The root Next.js production dependency audit reported zero known vulnerabilities. The server result is separately captured in M-02.

## 4. Residual Risks & Recommendations

### Architecture and product controls

1. **Treat Arc as a public broadcast medium.** Create a formal “allowed on-chain fields” schema. No email-, phone-, name-, message-, invoice-, task-, or address-like free text should cross it. Add automated tests that decode every emitted event/calldata and assert that only approved opaque values are present.
2. **Separate identity from wallet recovery.** A login subject, verified communication channel, Evabob account, and Circle wallet are different principals. Model explicit, auditable links between them with step-up proof, notifications, cooling-off, and revocation instead of silent email merging.
3. **Centralize authorization.** Media, threads, reviews, receipts, agent wallets, and held payments need policy functions that default deny and are tested across owner, counterparty, operator, agent, anonymous, and deleted-account states.
4. **Adopt data lifecycle primitives.** Every personal-data record needs owner/subjects, purpose, processor, creation time, retention class, deletion status, and legal-hold state. Backups and Mongo snapshot generations need bounded expiry. Public capabilities need revoke/rotate/expire.
5. **Use a secrets manager/HSM boundary.** Move Circle entity secrets, API keys, Mongo/SMTP/Pusher secrets, and hot Arc signers out of local `.env` in hosted environments. Keep the admin in a monitored multisig; use narrowly funded hot roles, rotation drills, and on-chain alerts.
6. **Protect screen and background state.** Add Android `FLAG_SECURE`/appropriate iOS capture handling for PIN, wallet, chat, evidence, and recovery screens; redact the app-switcher snapshot. Explicitly configure Android backup/data-extraction rules and verify secure-storage behavior during backup/restore.
   *Update 25 Sep 2026:* `FLAG_SECURE` was removed app-wide at the product owner's request, so receipts can be shared and the app shown in presentations. The PIN itself is entered in Circle's own screen. Screen capture is therefore an accepted risk for now; revisit before real money.

### Missing privacy/security controls

- Real privacy notice, Terms, processor/subprocessor list, contact point, age policy, lawful-basis/consent record, cross-border transfer assessment, retention schedule, access/export/correction/deletion workflows, and incident/breach response.
- New-device/login alerts, active-session/device list, remote session revocation, and sensitive-action re-authentication.
- Recipient blocking/reporting, invite/consent controls for chat, abuse/fraud monitoring, anti-enumeration controls, and recovery protections against SIM/email takeover.
- Media malware scanning and metadata stripping (EXIF/geolocation), authenticated media access logs, and user-visible delete controls.
- Generic-by-default notification previews and an explicit privacy setting.
- CSP/reporting and browser header monitoring on the Next.js deployment.

### Suggested additional testing

- **Mobile dynamic test:** install a release-signed Android APK; proxy traffic on hostile Wi-Fi; inspect logcat, backups, WebView storage/cookies, screenshots, app-switcher snapshots, clipboard, notification previews, and deep-link dispatch. Test rooted/jailbroken and lost-device scenarios.
- **Authentication abuse:** collect every Dynamic token state (OTP pending, MFA pending, ID token, access token, expired, wrong environment/audience) and assert only a completed access token succeeds. Test email change, deleted/recreated Dynamic users, provider linking, and recovery races.
- **Authorization matrix:** automatically exercise every `/v1` route as anonymous, user A, user B, operator, valid agent, revoked agent, and deleted user. Include guessed transfer/thread/media/public IDs and ensure no existence oracle where privacy matters.
- **LLM red team:** inject instructions through contact names, invoice descriptions, chat history, paywall content, and external seller responses. Assert no model output can skip confirmation, expand data scope, or leak another user. Capture outbound model payloads and verify field-level minimization.
- **Financial invariants:** fuzz amount precision, duplicate callbacks, stale challenges, chain reorganizations, partial batches, cross-chain timeout/recovery, refund/claim races, and idempotency across process restarts and multiple instances.
- **Contract testing:** Foundry invariants for total token conservation, one terminal state per escrow, bounded attestor power, pot refund completeness, circle queue/debt conservation, malicious token return data, and role rotation. Run Slither plus independent manual review.
- **Privacy attack simulation:** hash real-looking email dictionaries against a test registry, scrape event logs, follow wallet graphs, test public-link leakage through common messaging previews, and verify end-to-end erasure including processors and restored backups.

### Dependency and supply-chain hardening

- Generate CycloneDX/SPDX SBOMs for npm, Dart/Flutter, Gradle, and Foundry dependencies on every release; sign artifacts and record provenance.
- Pin exact versions and lock/checksum all mobile/native dependencies. Remove `1.0.+` and runtime CDN imports.
- Gate builds on critical/high advisories unless a time-bounded, owner-approved reachability assessment exists. Reassess Circle package advisories whenever App Kit changes.
- Scan commits and full Git history for secrets; current `.env` files are ignored and were not found tracked in the inspected history, but the live values still require secrets-manager storage and rotation discipline.

### Arc-specific hardening

- Publish and verify deployed bytecode/source, chain ID, contract addresses, role addresses, and Safe threshold. The client/server must reject unexpected chain IDs or contract addresses.
- Monitor `AdminUpdated`, `LinkerUpdated`, `ClaimAttestorUpdated`, identity link/unlink, unusually large/rapid escrow actions, and failed keeper/reconciliation jobs.
- Replace public PII-derived identity mappings and free-text events before mainnet. Assume all existing testnet/mainnet history is permanent and indexable.
- Document the claim-versus-refund race after expiry and show exact chain state before signature. Add simulations and transaction-receipt verification for every terminal UI state.
- Keep hot signer roles least-privileged and separately funded. Compromise of the linker, attestor, ops wallet, or agent custody service must have explicit blast-radius limits and emergency runbooks.

---

**Release decision:** Do not launch with real consumer funds or private user data until C-01, H-01 through H-09, and the active-key rotation in H-03 are remediated and independently retested. Medium findings affecting notifications, deep links, dependency integrity, and browser framing should be fixed before public distribution, not deferred as post-launch polish.
