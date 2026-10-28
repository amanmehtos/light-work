# First-party apps

How Light Week for iOS and Light Minute reach the account. This is the contract
the Swift clients implement against, and it is deliberately the same OAuth
machinery the MCP endpoint uses — a second sign-in system would be a second
thing to get wrong.

## Why not just a session token

The web app keeps a session token in `localStorage`, and for a long time the
only way to give anything else access was to copy it out. That token is the
whole account with no scope, no audience and no way to revoke one client
without signing out everywhere.

An app gets an OAuth grant instead: scoped, bound to this server as its
audience, revocable on its own, and visible to you on a consent screen that
names it before anything is issued.

## Two resources, one server

| Surface | Resource | Scopes |
| --- | --- | --- |
| MCP endpoint | `<origin>/mcp` | `mcp:read`, `mcp:write` |
| Sync API | `<origin>/sync` | `tasks:read`, `tasks:write` |

Both belong to one server, so a token minted here has the same audience either
way and `resourceMatches` accepts the origin or either path. **Scope, not
audience, is what separates the two surfaces.** RFC 8707's check answers "was
this token minted for this server"; it was never meant to answer "for which of
its endpoints". So an `mcp:*` grant is refused on `/sync` with `403`, and a
`tasks:*` grant gets no MCP tools.

Discovery documents are per resource, each advertising only the scopes that mean
something to it:

- `/.well-known/oauth-protected-resource` — the MCP resource
- `/.well-known/oauth-protected-resource/sync` — the sync API
- `/.well-known/oauth-authorization-server` — RFC 8414, shared

A `401` from `/sync` carries `WWW-Authenticate` pointing at the sync document
and asking for `tasks:read tasks:write`, so a client that knocks in the wrong
place is told where to go rather than left to guess.

## The two built-in clients

| `client_id` | Name shown on consent | `redirect_uri` |
| --- | --- | --- |
| `com.lightweek.ios` | Light Week for iOS | `com.lightweek.app:/oauth` |
| `com.lightminute.ios` | Light Minute for iOS | `com.lightminute.app:/oauth` |

These live in `FIRST_PARTY_CLIENTS` in `packages/server-core/src/oauth.ts`, not
in the database. A client list is configuration; seeding it by migration would
put these rows in D1 and leave them missing from the `node:sqlite` target, so
the same build would behave differently depending on where it ran.

Being built in is also what lets the consent screen mean something. Anything
registered through RFC 7591 names *itself* — a client may call itself "Light
Week for iOS" — so a name is only worth showing when the server vouches for it.

Redirect URIs use the single-slash `scheme:/path` form of RFC 8252 and are
compared **exactly**. `com.lightminute.app://oauth` is a different string and
will be refused.

## The flow, from the app's side

1. `ASWebAuthenticationSession` to `/oauth/authorize` with `response_type=code`,
   the `client_id`, the exact `redirect_uri`, `code_challenge` +
   `code_challenge_method=S256`, `scope=tasks:read tasks:write`, a `state` you
   generate, and `resource=<origin>`.
2. The user signs in if needed — with Google, or an email code — and the consent
   screen names the app and the scopes.
3. The redirect comes back to the custom scheme with `code`, `state` and `iss`.
   **Check `state` and check `iss` is this origin**; the server advertises
   `authorization_response_iss_parameter_supported`, so a client that is told
   this and does not verify it is failing a check it asked for.
4. `POST /oauth/token` with `grant_type=authorization_code`, the code, the
   `client_id`, the same `redirect_uri` and the `code_verifier`. No client
   secret: these are public clients and PKCE is what binds the code.
5. Keep the tokens in the **Keychain**. Refresh with
   `grant_type=refresh_token`; refresh tokens rotate, so store the new one.

PKCE is S256 only. OAuth 2.1 drops `plain`, and accepting it would let anyone
who sees the authorization request replay it.

## What a grant may do

`GET /sync/snapshot`, `GET /sync/pull?since=`, `GET /account/me` need
`tasks:read`. `POST /sync` needs `tasks:write`.

Three things an app cannot do, whatever it holds:

- **`POST /oauth/approve`** — handing out access is the user's own act. An app
  that could grant would be able to widen its own reach.
- **`POST /account/logout`** — that revokes a *session*. An app's grant is
  revoked by the user from the account that issued it.
- **`GET /sync/socket`** — the realtime channel takes its token from the query
  string and accepts sessions only. Apps poll `/sync/pull` on foreground
  instead. Realtime for apps needs its own thought about query-string
  credentials before it is worth having.

## Writing ops from Swift

`POST /sync` takes `{ version: 1, since, ops }`. Each op is
`{ id, kind, entityId, type, fields?, clock, node }`, and the server is strict
about the formats, all defined in `packages/core/src`:

- **Ids** (`ids.ts`): `Date.now()` in base 36 left-padded to 8, then 16 random
  characters from `0-9a-z`. 24 characters.
- **Node id**: `n` plus 10 characters from the same alphabet, stable per device.
  It breaks clock ties and is how a client ignores the echo of its own pushes.
- **Clock** (`hlc.ts`): `encodeHLC` — the wall clock in base 36 padded to 11, a
  colon, the counter in base 36 padded to 5, a colon, the node id. The counter
  increments within a millisecond and resets when the wall advances.
- **Order** (`order.ts`): base-62 fractional keys, never ending in `0`. Only
  needed for entities that have an `order`; `focusSession` does not.

`fields` is a **sparse patch**, not a whole row. Send only what changed, or you
will clobber a field another device edited.

A push is idempotent on `id`: a retried op is reported accepted and applied
once. So an app should keep its outbox until the server acknowledges, and may
safely resend.

## Focus sessions

What Light Minute writes. `kind` is `focus`, `short_break` or `long_break`;
`outcome` is `running`, `completed` or `abandoned`; `source` identifies the app,
e.g. `light-minute-ios`.

`plannedSeconds` is what the timer was set to and `focusedSeconds` is what was
actually spent with the clock running — they differ, and the difference is the
interesting part. `interruptions` counts pauses and times the app was left.

An abandoned session should still be written. A timer that only records its
successes produces statistics that flatter you.

## Starting one from a task

Light Week hands a task to Light Minute over a custom-scheme link, and this is
the other half of the arc: the focus session that comes back through `/sync`
above is the one that started here.

```
com.lightminute.app:/focus?taskId=…&title=…&projectName=…&projectId=…&planned=1500
```

| Parameter | |
| --- | --- |
| `taskId` | **Required.** The only one the server ever sees — it is what the session is filed against. |
| `title` | What the timer puts on screen. A link without one still binds. |
| `projectName` | Shown beside the title. |
| `projectId` | Stored on the session when present. |
| `planned` | Seconds. Floored at 60. |

Percent-encode every value as RFC 3986 unreserved-only: a task called
`C++ & co` otherwise either changes the shape of the query it sits in or
arrives with its `+` read as a space, depending on which convention the reader
follows.

`planned` is **advice for one session**, not a change to anyone's focus length
— Light Week sends the task's own `duration` when it has one in minutes, and
`1500` when it does not. A `day` duration is an estimate of elapsed time rather
than of focus, so it is no guide at all and the default is used instead.

The single-slash form is RFC 8252's, as with the redirect URIs above. Unlike
those, Light Minute reads the two-slash spelling as well — but the OAuth
redirect is byte-compared, so the two are not interchangeable and there is no
reason to send the spelling that only works by the reader's forgiveness.

Before opening, check `canOpenURL` and say plainly that Light Minute is not
installed if it answers no. Both apps declare the other's scheme in
`LSApplicationQueriesSchemes`; without that, the check answers no however
installed the other app is.

This link was written down only in Light Minute's own repository for a while,
which is how a contract between two apps quietly becomes a contract between two
memories.
