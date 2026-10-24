# Deploying

Everything here fits inside Cloudflare's free plan. The limits that actually
bind are listed at the end.

## First time

```sh
pnpm install
cd services/api

# D1 holds only users, sessions and sign-in codes.
npx wrangler d1 create light-week-auth
# Paste the returned id into wrangler.jsonc as database_id.

npx wrangler d1 migrations apply light-week-auth --remote
npx wrangler deploy
```

The Durable Object needs no provisioning; the migration in `wrangler.jsonc`
creates the class on first deploy.

## Secrets

```sh
npx wrangler secret put RESEND_API_KEY   # sign-in emails
npx wrangler secret put MAIL_FROM        # e.g. "Light Week <login@example.com>"
```

Without `RESEND_API_KEY` the server refuses to send codes, except in local
development where `DEV_LOGIN=1` returns the code in the response instead.
That path is gated on the variable so it cannot be reached in a deployed Worker.

Any provider works; `src/auth.ts` has one `deliverCode` function to change.

## Housekeeping

Add a cron trigger so expired sessions and codes are pruned:

```jsonc
"triggers": { "crons": ["0 4 * * *"] }
```

## Local development

```sh
cd services/api
npx wrangler d1 migrations apply light-week-auth --local
DEV_LOGIN=1 npx wrangler dev
```

Then sign in without email:

```sh
curl -s localhost:8787/auth/request-code \
  -H 'content-type: application/json' -d '{"email":"me@example.com"}'
# -> {"ok":true,"devCode":"123456"}

curl -s localhost:8787/auth/verify-code \
  -H 'content-type: application/json' \
  -d '{"email":"me@example.com","code":"123456"}'
# -> {"token":"...","user":{...}}
```

## Tests

```sh
pnpm -r test        # everything
pnpm -r typecheck
```

The API tests run in workerd with a real Durable Object, real D1 and real
WebSockets — not mocks — so they catch the things that only break in the Workers
runtime.

## The limits that bind

| Workers Free | Allowance | Notes |
| --- | --- | --- |
| Worker requests | 100k/day | The first thing you outgrow |
| D1 rows written | 100k/day | **Queries fail past this**, since Sept 2026 |
| D1 rows read | 5M/day | |
| D1 storage | 5 GB | Account-wide |
| Durable Objects | SQLite-backed only | KV backend is paid-only |
| DO requests | 100k/day | |
| DO storage | 1 GB per object | Per account, which is a lot of tasks |

The architecture deliberately keeps task writes in the Durable Object so they do
not consume D1's 100k row-writes — D1 only sees a write when someone signs in.
What you outgrow first is the 100k Worker requests per day, and the answer is
the $5/month paid plan, which removes all of these.

Self-hosting on your own Cloudflare account is the intended path for anyone who
would rather not use the hosted instance; nothing here depends on a service
outside Cloudflare except the mail provider.
