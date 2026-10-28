# Runbook: rotate the Snowflake PAT

The Worker reaches Snowflake with a programmatic access token (PAT) for the service user `WINK_SVC`, stored as the Worker secret `SNOWFLAKE_PAT`. `snowflake/01_setup.sql` created the first one (`WINK_WORKER`) with `DAYS_TO_EXPIRY = 7` on 2026-10-26, so it **expires around 2026-11-02**.

Since PR #15 (2026-10-27) memories live in Neon Postgres (`neon/`), so Snowflake only serves Overture Maps Places. When the PAT expires:

- `POST /v1/nearby` fails with `snowflake_auth` (HTTP 502).
- Saves still work but skip the Overture business match (logged as `Overture business match skipped`), so new memories get no `place`.
- Save, ask, list and delete are unaffected, and `/v1/health` still says `ok`.

Owner: Arboy (account holder). Takes about 10 minutes. Never paste the token into chat, a commit, a screenshot or a shell history you share.

## 1. Check what exists

In a Snowsight worksheet as `ACCOUNTADMIN`:

```sql
SHOW USER PROGRAMMATIC ACCESS TOKENS FOR USER WINK_SVC;
```

Note `name`, `status` and `expires_at` for each token.

## 2. Create the new token

Add a second token first, so the old one keeps working until the switch is verified. Name it by date.

```sql
ALTER USER WINK_SVC ADD PROGRAMMATIC ACCESS TOKEN WINK_WORKER_2026_11
  ROLE_RESTRICTION = 'WINK_APP'
  DAYS_TO_EXPIRY = 90
  COMMENT = 'Wink Worker';
```

The result shows the secret **once**. Copy it straight into the next step.

Snowflake's default maximum is 365 days. 90 days is a balance between rotation effort and exposure; pick shorter while the network policy still allows every IP (see step 6).

## 3. Put it in the Worker

From `backend/`:

```bash
npx wrangler secret put SNOWFLAKE_PAT
```

Paste the token at the prompt (not as an argument, so it stays out of shell history). `wrangler secret put` deploys a new version of the Worker with the secret right away; no separate deploy is needed.

For local `npm run dev:real`, also replace `SNOWFLAKE_PAT` in `backend/.dev.vars` (gitignored).

## 4. Verify

With `WINK_TOKEN` exported in your shell:

```bash
curl -s https://wink-api.arboydev.workers.dev/v1/nearby \
  -H "Authorization: Bearer $WINK_TOKEN" -H 'Content-Type: application/json' \
  -d '{"memoryId":null,"query":"coffee","location":{"lat":35.2059,"lng":-97.4457}}' | head -c 400
```

A `{"speech":…,"places":[…]}` body means Snowflake accepted the new token (the location is the University of Oklahoma; any real one works). A `snowflake_auth` error means it didn't; the old token is still valid, so you can put it back while you check the role restriction and network policy.

Then do one real round trip in the app: "Hey Wink, where can I get this nearby?" after saving something with a recognizable brand or product.

## 5. Remove the old token

Only after step 4 passes:

```sql
ALTER USER WINK_SVC REMOVE PROGRAMMATIC ACCESS TOKEN WINK_WORKER;
SHOW USER PROGRAMMATIC ACCESS TOKENS FOR USER WINK_SVC;
```

Put a reminder in your calendar a week before the new `expires_at`.

Alternative: `ALTER USER WINK_SVC ROTATE PROGRAMMATIC ACCESS TOKEN WINK_WORKER EXPIRE_ROTATED_TOKEN_AFTER_HOURS = 1;` issues a new secret under the same name and keeps the old one valid for an hour. Adding a new token is preferred here because the old one stays valid for as long as verification takes.

## 6. Network policy (still open)

PATs on a `TYPE = SERVICE` user only work under a network policy, and Cloudflare Workers don't have fixed egress IPs, so setup attached `WINK_HACKATHON_POLICY` allowing `0.0.0.0/0` to `WINK_SVC` only. That means a leaked PAT works from anywhere until it expires or is removed. Mitigations today: the PAT is restricted to role `WINK_APP` (only the Overture share and the old `WINK` database, which no longer holds live memories), the role can't create objects, and expiry is short.

Options, in order of preference:

1. **Key-pair (JWT) auth instead of a PAT.** The SQL API accepts a JWT signed with an RSA key registered on the user (`ALTER USER WINK_SVC SET RSA_PUBLIC_KEY = '…'`). It needs no network policy, the private key lives only as a Worker secret, and `RSA_PUBLIC_KEY_2` allows overlap during rotation. This is a code change in `backend/src/snowflake.ts` (sign a JWT with WebCrypto, send `X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT`). Tracked on the roadmap.
2. **Replace Snowflake for nearby.** Memories already moved to Neon (PR #15); once `/v1/nearby` and the business match use another places source, drop the PAT and `WINK_SVC` entirely.
3. **Restrict the network rule to Cloudflare's published IPv4 ranges** (https://www.cloudflare.com/ips-v4). Unverified: Cloudflare doesn't promise that Worker subrequests leave from those ranges. If you try it, keep the old rule handy and re-run step 4 immediately; roll back with `ALTER NETWORK RULE WINK.APP.WINK_ALLOW_ALL SET VALUE_LIST = ('0.0.0.0/0');`.

Don't switch to an authentication policy with `NETWORK_POLICY_EVALUATION = NOT_ENFORCED` as a "fix": it removes the requirement but restricts nothing.

## If the token leaked

1. `ALTER USER WINK_SVC REMOVE PROGRAMMATIC ACCESS TOKEN <name>;` right away (the app is down until step 3).
2. Do steps 2–4 with a new token.
3. Check `SNOWFLAKE.ACCOUNT_USAGE.LOGIN_HISTORY` (filter `USER_NAME = 'WINK_SVC'`) and `QUERY_HISTORY` for client IPs and statements that weren't the Worker.
