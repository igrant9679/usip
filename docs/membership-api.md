# Membership API: signing up for a Velocity workspace

Owner, 2026-11-26: sign-up happens on the membership site (meyousocial.com, WordPress with MemberPress) and inside the app. This is the contract between the two. The code is `server/membershipApi.ts`, `server/services/membership.ts` and `shared/membership.ts`; `server/membership.test.ts` holds every rule below.

## The two doors

| Door | Who takes the sign-up | What Velocity does |
|---|---|---|
| The website | MemberPress: the account, the plan, the payment | Makes the workspace and its owner when the site says a membership was sold |
| The app | Velocity: someone registers at `https://getvelocityai.app/?signup=1` | Lets them create one workspace on the Trial plan, when the owner has opened that |

Velocity never sees a card. The website never sees a Velocity password. Paid plans are only ever sold on the website.

## Setting it up

Three variables on the Velocity deployment (Railway → the service → Variables). A change redeploys.

| Variable | Needed | What it does |
|---|---|---|
| `MEMBERSHIP_API_SECRET` | For the website door | The shared secret the website signs with. At least 32 characters. While it is unset, or shorter, every signed route answers 503 and does nothing. |
| `SELF_SERVE_SIGNUP` | For the app door | `trial` opens sign-up inside the app. Anything else, or unset, leaves it closed (the behaviour before this change). |
| `MEMBERSHIP_SITE_URL` | Optional | An `https` address where plans are bought. The app shows it as "See membership plans" to someone with no workspace. |

The owner makes the secret (a password manager's 40+ character random string is right) and puts the same value in both places. On WordPress keep it out of the database and out of any page:

```php
// wp-config.php
define('VELOCITY_MEMBERSHIP_SECRET', '...the same value as on Railway...');
define('VELOCITY_API_BASE', 'https://getvelocityai.app');
```

Never put the secret in JavaScript, a shortcode, a form field or a REST response. Every signed call is made by the WordPress server.

## Signing a request

Every `POST` carries two headers:

```
X-Velocity-Timestamp: <unix seconds, UTC>
X-Velocity-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
Content-Type: application/json
```

The signature covers the body exactly as it is sent, byte for byte, so sign the string you send (do not re-encode it afterwards). A timestamp more than five minutes from Velocity's clock is refused.

```php
function velocity_membership_call(string $path, array $payload) {
    $body = wp_json_encode($payload);
    $ts   = (string) time();
    $sig  = hash_hmac('sha256', $ts . '.' . $body, VELOCITY_MEMBERSHIP_SECRET);

    $res = wp_remote_post(VELOCITY_API_BASE . $path, [
        'timeout' => 20,
        'headers' => [
            'Content-Type'         => 'application/json',
            'X-Velocity-Timestamp' => $ts,
            'X-Velocity-Signature' => 'sha256=' . $sig,
        ],
        'body' => $body,
    ]);
    if (is_wp_error($res)) return $res;

    $code = wp_remote_retrieve_response_code($res);
    $json = json_decode(wp_remote_retrieve_body($res), true);
    return ['status' => $code, 'body' => is_array($json) ? $json : null];
}
```

## The routes

Base: `https://getvelocityai.app`. Every answer is JSON with `ok: true`, or `ok: false` with a `code` and an `error` sentence.

### `GET /api/membership/plans` (open, no signature)

The plans and what each includes, for a pricing page. Cached for five minutes.

```json
{
  "ok": true,
  "plans": [
    { "id": "trial",       "label": "Trial",       "prospectRecordsPerMonth": 250 },
    { "id": "member",      "label": "Member",      "prospectRecordsPerMonth": 1000 },
    { "id": "contributor", "label": "Contributor", "prospectRecordsPerMonth": 3000 },
    { "id": "steward",     "label": "Steward",     "prospectRecordsPerMonth": 5000 },
    { "id": "founder",     "label": "Founder",     "prospectRecordsPerMonth": 6000 }
  ],
  "appSignUp": "off",
  "membershipSiteUrl": null
}
```

`appSignUp` is `"trial"` when the app's own sign-up is open.

### `POST /api/membership/provision`

A membership was sold: make its workspace and its owner.

```json
{
  "externalId": "mp-user-4821",
  "email": "dana@northwind.example",
  "name": "Dana Reyes",
  "workspaceName": "Northwind Sales",
  "plan": "contributor"
}
```

| Field | Required | Notes |
|---|---|---|
| `externalId` | yes | The site's own id for this membership. One id is one workspace, for the membership's whole life. Letters, digits, `.` `-` `_` `:`; up to 120 characters; a bare number is accepted. See "Choosing the externalId". |
| `email` | yes | The owner's address. |
| `plan` | yes | `trial`, `member`, `contributor`, `steward` or `founder`. |
| `name` | no | The owner's name. |
| `workspaceName` | no | 2 to 120 characters. Left out, it is "Dana's Workspace". The owner can rename it in Settings. |

Answer:

```json
{
  "ok": true,
  "created": true,
  "account": "new",
  "externalId": "mp-user-4821",
  "workspaceId": 17,
  "workspaceName": "Northwind Sales",
  "plan": "contributor",
  "status": "active",
  "activationPending": true,
  "activationUrl": "https://getvelocityai.app/invite/accept?token=…",
  "signInUrl": "https://getvelocityai.app/"
}
```

- **A new address** (`account: "new"`) gets `activationUrl`: the page where the owner sets their password and lands in the workspace. **Send it by email to that address, and nowhere else** (see "The activation link is a key"). It works for 30 days and can be issued again (`/activation`).
- **An address that already has a Velocity account** (`account: "existing"`) gets the workspace added to that account at once. `activationUrl` is null; send them to `signInUrl`.
- **Safe to send twice.** The same `externalId` again makes nothing and changes nothing: `created` is false and the answer is what is already there, including the unused activation link. A different `plan` on a repeat is ignored; plan changes go through `/update`.
- **Two at once.** If the same sale arrives twice in the same moment, one makes the workspace and the other gets `409 in_progress`. Send it again a few seconds later and it answers with the workspace.

### `POST /api/membership/update`

The plan changed, or the membership ended or came back. Send `plan`, `status`, or both.

```json
{ "externalId": "mp-user-4821", "plan": "steward" }
```

```json
{ "externalId": "mp-user-4821", "status": "ended" }
```

| `status` | What happens |
|---|---|
| `ended` | The workspace is archived: every engine stops (no sending, no discovery, no AI runs), members below the owner are refused, nothing is deleted. The owner can still open it and read or export their data, and cannot restore it themselves. |
| `active` | A workspace archived by `ended` is restored and its engines resume. |

The answer is the same shape as `/status` below, plus `previous: { plan, status }`.

Send `ended` when the member has actually lost access (the paid period is over, or a refund), not when they switch off auto-renew: they have paid until the period ends.

### `POST /api/membership/status`

```json
{ "externalId": "mp-user-4821" }
```

```json
{
  "ok": true,
  "externalId": "mp-user-4821",
  "workspaceId": 17,
  "workspaceName": "Northwind Sales",
  "plan": "contributor",
  "status": "active",
  "activationPending": false,
  "activationUrl": null,
  "signInUrl": "https://getvelocityai.app/",
  "usage": { "used": 412, "limit": 3000, "resetsOn": "2026-12-01" }
}
```

`usage` is this month's prospect records against the plan, for an account page ("412 of 3,000 used"). It is null when it cannot be read; never show null as zero.

### `POST /api/membership/activation`

```json
{ "externalId": "mp-user-4821" }
```

Issues a fresh first-sign-in link for an owner who has not used theirs (it lapsed, or the email was lost). The old link stops working. An owner who has already set a password gets `activationUrl: null`: they sign in, or use "Forgot password" on the sign-in page.

## The activation link is a key

Whoever opens `activationUrl` sets the password for the Velocity account on that email address, and Velocity then treats the address as confirmed. MemberPress does not prove at checkout that the buyer owns the address they typed. So:

- Deliver the link only in an email sent to that address (the welcome email). Receiving it is the proof.
- Do not show it on the thank-you page, the account page, in a redirect or in any response a browser can read. Someone who signed up with another person's address would otherwise take that person's Velocity account before they ever had one.
- Do not log it.

The link still works when other invitations are waiting on the same address (a second membership bought before the first sign-in, or an invitation from a workspace admin). After signing in, the owner accepts those from the app.

## Errors

| HTTP | `code` | Meaning | Retry? |
|---|---|---|---|
| 400 | `invalid` | A field is missing or wrong; `error` names it | No: fix the request |
| 401 | `unsigned`, `bad_signature`, `stale` | Headers missing, the signature does not match, or the clock is off by more than five minutes | No: fix the signing or the server clock |
| 404 | `not_found` | No workspace was made for this `externalId` | Provision first |
| 409 | `in_progress` | The same sale is being handled right now | Yes, after a few seconds |
| 429 | `rate_limited` | More than 120 calls a minute from one address | Yes, after a minute |
| 500 | `failed` | Velocity could not finish; nothing was left half-made | Yes, with a pause |
| 503 | `not_configured`, `unavailable` | The secret is not set on Velocity, or its database is down | After it is fixed |

A failed `provision` leaves nothing behind, so sending it again is always safe.

## Choosing the externalId

The id must stay the same for as long as the membership lasts, because it is how every later call finds the workspace.

- **One workspace per member (recommended):** `mp-user-<WordPress user id>`. It survives upgrades, downgrades and renewals, which in MemberPress can each be a new subscription or transaction.
- **A member who buys a second workspace:** a second id, such as `mp-user-4821-2`.
- Avoid a transaction id: every renewal is a new transaction.

Store the answer's `workspaceId` on the WordPress user (user meta) for support, but always call with the `externalId`.

## What to wire on the WordPress side

A small plugin (or additions to the site's own plugin) that listens to MemberPress and calls the routes. Check each hook's name and arguments against MemberPress's own developer documentation before relying on it; the list below is what to look for, not a tested mapping.

| When, in MemberPress | Call |
|---|---|
| A sign-up completes and the first payment (or free trial) is confirmed | `provision` with the plan that membership maps to |
| The member moves to another membership (upgrade or downgrade) | `update` with the new `plan` |
| A subscription or one-time access expires, or a payment is refunded | `update` with `status: "ended"` |
| An ended member pays again | `update` with `status: "active"` (and `plan` if it changed) |
| The member turns off auto-renew | Nothing yet: they keep access until the period ends |
| The account page is shown | `status`, to show the plan, the usage and an "Open Velocity" button (`signInUrl`) |
| "Email me my activation link again" is pressed | `activation`, then email the new link to the member's address |

A mapping table in the plugin from MemberPress membership (product) id to plan id:

```php
const VELOCITY_PLAN_BY_MEMBERSHIP = [
    // MemberPress membership id => Velocity plan id
    // 123 => 'trial',
    // 124 => 'member',
    // 125 => 'contributor',
    // 126 => 'steward',
    // 127 => 'founder',
];
```

Good practice on that side:

- Call from a background action where possible, so checkout does not wait on Velocity. If the call fails, keep the event and retry (provision is safe to repeat).
- Log the HTTP status and `code` of each call, never the secret or the signature.
- On the thank-you page: for a new account, say "Check your email for your link into Velocity"; for an existing account, show `signInUrl` as the button into Velocity. Never print `activationUrl` on a page.

## Testing it without WordPress

With the secret in a shell variable (never typed into a file that is committed):

```bash
BODY='{"externalId":"test-1","email":"someone@example.com","name":"Test Person","plan":"trial"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$MEMBERSHIP_API_SECRET" -r | cut -d' ' -f1)
curl -sS https://getvelocityai.app/api/membership/provision \
  -H "Content-Type: application/json" \
  -H "X-Velocity-Timestamp: $TS" \
  -H "X-Velocity-Signature: sha256=$SIG" \
  -d "$BODY"
```

A test workspace made this way is real. End it with `update` `status: "ended"` when done, and tell the platform owner so it can be removed.

## Sign-up inside the app

- `https://getvelocityai.app/?signup=1` opens the sign-in page on "Create account". Use it for a "Start in the app" link on the website.
- After registering, someone with no workspace sees one of three things:
  - **Create your workspace** (a name field), when `SELF_SERVE_SIGNUP=trial` and their address is confirmed. It is made on the Trial plan. One per account.
  - **Confirm your email address first**, with a resend button, when their address is not confirmed yet.
  - **You're not in a workspace yet**, when in-app sign-up is closed. With `MEMBERSHIP_SITE_URL` set, a "See membership plans" link takes them to the website.
- A Trial workspace made in the app has no website membership, so the routes above cannot reach it. To move it to a paid plan today, the platform owner sets its plan in Settings → Billing and credits. (Connecting an in-app Trial to a later website purchase is not built.)

## What this API will not do, on purpose

- **Sign anyone in.** There is no "log in as" link. The first-sign-in link works only for an owner who has never set a password, and a compromised website cannot use it to enter an existing account.
- **Reach a workspace it did not make.** Every call finds its workspace through the website's own record of the sale. The operator's and clients' workspaces have no such record.
- **Delete anything.** Ending a membership archives; removal is the platform owner's decision in the app.
- **Take or store a payment, a card or a password.**
