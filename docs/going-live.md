# Going live

Roughly forty minutes, most of it waiting for DNS. Everything below fits inside
Cloudflare's free plan.

## 0. The code is on GitHub

It lives at <https://github.com/amanmehtos/light-work>. Clone it with its
submodule, which carries Diurnal UI:

```sh
git clone --recurse-submodules git@github.com:amanmehtos/light-work.git
cd light-work
pnpm install
pnpm -r test          # 245 passing
```

An existing clone that predates the submodule needs
`git submodule update --init`.

## 1. Wrangler and Cloudflare

Wrangler authenticates two ways, and you want both: interactive for your own
machine, an API token for CI.

### On your machine

```sh
npx wrangler login     # opens a browser, stores an OAuth token
npx wrangler whoami    # confirm the account it picked
```

A free account is enough. Nothing below needs a paid plan.

If the login shows more than one account, add the right one to
`wrangler.jsonc` as `"account_id": "..."` so deploys cannot land in the wrong
place.

### For CI

`wrangler login` cannot work in a runner, so CI uses an account-owned API
token through environment variables. Create it at **My Profile → API Tokens →
Create Token**, starting from the **Edit Cloudflare Workers** template, and add
**Account → D1 → Edit** so the workflow can apply migrations.

| Permission | Why |
| --- | --- |
| Account → Workers Scripts → Edit | Deploying the Worker (covered by the template) |
| Account → D1 → Edit | `wrangler d1 migrations apply --remote` |
| Zone → Workers Routes → Edit | Only if you attach a custom domain on a zone |

Durable Objects have no separate permission of their own; the Workers template
covers them. If a deploy fails with a permissions error naming a product, add
that product's Edit permission and try again — the error says which.

Then add two repository secrets under **Settings → Secrets and variables →
Actions**:

- `CLOUDFLARE_API_TOKEN` — the token above
- `CLOUDFLARE_ACCOUNT_ID` — from the dashboard sidebar, or `wrangler whoami`

Optionally add a repository **variable** `PUBLIC_URL` (e.g.
`https://lightweek.app`), and the deploy workflow will curl `/healthz`
afterwards to prove the release is alive.

With those set, `.github/workflows/deploy.yml` deploys on every push to `main`:
it checks the token, builds the app, applies migrations, deploys, and smokes
the result. Migrations run *before* the deploy so a failed one blocks the
release rather than shipping code against the old schema.

## 2. The database

D1 holds only users, sessions and sign-in codes; the task data lives in Durable
Objects and needs no provisioning.

```sh
cd services/api
npx wrangler d1 create light-week-auth
```

Paste the id it prints into `wrangler.jsonc` as `database_id`, replacing the
zeroes, then:

```sh
npx wrangler d1 migrations apply light-week-auth --remote
```

## 3. Email

**Without this nobody can sign in, including you.** There are no passwords —
the only way into an account is a code sent by email.

Get a key from [Resend](https://resend.com) (free tier: 3,000 emails a month,
100 a day), verify a sending domain, then:

```sh
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM       # e.g. "Light Week <login@lightweek.app>"
```

Any provider works; `services/api/src/adapters.ts` has one `ResendMailer` class
to swap. Until a key is set the server refuses sign-in requests loudly rather
than silently sending nothing.

Do **not** set `DEV_LOGIN` in production. It makes the server hand sign-in
codes back in the HTTP response, which would let anyone sign in as anyone. It
lives in `.dev.vars`, which wrangler reads only locally and never uploads.

## 4. Deploy

From the repository root:

```sh
pnpm install
pnpm deploy
```

That builds the web app and deploys one Worker serving both it and the API.

One Worker rather than two is deliberate. Static assets on Workers are served
by Cloudflare directly and are **free and unmetered** — only requests that
actually invoke the Worker count against the 100k/day — so the app costs
nothing to serve, there is no CORS to configure, and the app and API share an
origin. `run_worker_first` in `wrangler.jsonc` lists the paths the API owns;
everything else falls through to the built app.

To see exactly what would ship without shipping it:

```sh
pnpm deploy:check
```

## 5. Check it

```sh
curl https://light-week.<your-subdomain>.workers.dev/healthz
# {"name":"light-week-api","protocol":1,"platform":"cloudflare","docs":"...","ok":true}
```

Then open the same host in a browser, sign in with your own address, and add a
task. If the code never arrives, the mail provider is the thing to look at:

```sh
npx wrangler tail
```

## 6. A domain, if you want one

In the Cloudflare dashboard: Workers & Pages → `light-week` → Settings →
Domains & Routes → Add custom domain. DNS is handled for you if the domain is
already on Cloudflare.

Nothing in the code hard-codes a hostname, so there is nothing to change.

## 7. Bring your Todoist across

Dry run first — it writes nothing and prints what it found:

```sh
pnpm --filter @light/todoist-import exec tsx src/cli.ts \
  --token <todoist-api-token> --out ops.json
```

Read the counts and the warnings. Then push it into your new account, using a
session token from the browser's local storage (`light-week.token`):

```sh
pnpm --filter @light/todoist-import exec tsx src/cli.ts \
  --in ops.json --push https://<your-host> --auth <session-token>
```

Ids are derived from the Todoist ones, so running it twice does not duplicate
anything. See [migrating-from-todoist.md](migrating-from-todoist.md), and read
the caveat at the end of it before trusting a large migration.

## 8. Point an agent at it

```sh
claude mcp add --transport http light-week https://<your-host>/mcp \
  --header "Authorization: Bearer <session-token>"
```

See [mcp.md](mcp.md) for the tools.

## What to watch

| Limit | Free allowance | What happens at the edge |
| --- | --- | --- |
| Worker requests | 100k/day | The first thing you outgrow |
| D1 rows written | 100k/day | **Queries fail**, since Sept 2026 |
| D1 rows read | 5M/day | |
| D1 storage | 5 GB | Account-wide |
| Durable Object requests | 100k/day | |
| Durable Object storage | 1 GB per account | A very large number of tasks |
| Resend | 3k/month, 100/day | Sign-ins stop |

The architecture keeps task writes in Durable Objects precisely so they do not
spend D1's row-write budget — D1 only sees a write when somebody signs in. What
binds first is the 100k Worker requests a day, and the answer is the $5/month
Workers Paid plan, which removes every limit in that table except Resend's.

Watch it with `npx wrangler tail`, or in the dashboard under Workers &
Pages → `light-week` → Observability, which the config already enables.

## Rolling back

```sh
npx wrangler deployments list
npx wrangler rollback [deployment-id]
```

Rolling back the Worker does not roll back a D1 migration. The migrations here
only ever add tables, so an older Worker runs fine against a newer schema.

## What is not live after this

- **The iPhone app** does not exist; `apps/ios` holds only the shared contract,
  uncompiled. See [its README](../apps/ios/README.md).
- **The desktop app** has a Tauri config that has never been built.
- **Sharing** is not implemented — projects are single-user.
- **MCP uses a session token**, so pointing an agent at your account means
  handing it a credential. OAuth is the next piece of work there.
- **The web app has no PWA icons**, so it installs with a default one.
