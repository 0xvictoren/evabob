# Privacy operations

This file is the engineering control record behind the public Privacy Notice.
It is not a substitute for counsel reviewing the notice, processor contracts,
or applicable financial-record obligations before a consumer launch.

## Data minimisation and retention

| Data | Default retention | Deletion behaviour |
| --- | --- | --- |
| Authentication/session data | Active session plus security history | Sessions are revoked where the provider supports it; local tokens are removed |
| Profile, contacts, push devices | Account life | Deleted or anonymised on verified account deletion |
| Chat text | Account life | Deleted on account deletion unless required as financial evidence |
| Chat photos | 180 days maximum | Access revoked immediately; object removed on deletion/expiry |
| Review evidence | 365 days maximum | Access revoked immediately; retained only for an open/legal dispute |
| Public receipt links | Until revoked or their optional expiry | Secret is removed on revoke/deletion |
| Financial and blockchain evidence | Applicable legal/accounting period | Off-chain personal fields are minimised; public chain records cannot be erased |
| Operational logs | Short incident-response window | No raw email, phone, wallet, token, key, capability URL, or upload name |
| Backups | Provider rotation window | Deleted data expires as backups rotate and is not restored into live service |

## AI processing assessment

External AI is opt-in per user and remains disabled by the production privacy
kill switch. The application must not send contact books, email addresses,
phone numbers, wallet addresses, transaction hashes, capability URLs, uploaded
media, or prior chat history to an external model. Exact contact and financial
lookups stay in Evabob's deterministic local tools. If external AI is enabled
later, turns must use temporary aliases and the provider agreement must prohibit
training, define deletion handling, retention, sub-processors, incident notice,
and international-transfer safeguards.

The current DPIA conclusion is therefore **do not enable external model
processing in production** until those contractual controls are signed and a
cross-border transfer mechanism has been approved. A user toggle alone is not
sufficient to remove that operational block.

## Processor deletion runbook

The authenticated deletion endpoint removes Evabob-controlled profile,
contacts, chat content, media, device tokens, agent access, and public links.
Operations must separately confirm provider-side deletion or required retention
with Dynamic, Circle, Firebase, Pusher, Mongo hosting, SMTP delivery, and any
future AI provider. Circle/chain transaction records that must remain are
returned to the user in the deletion response rather than represented as erased.
