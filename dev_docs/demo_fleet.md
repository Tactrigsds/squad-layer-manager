# Demo fleet

The demo fleet is one box running many throwaway SLM instances. It is how somebody tries SLM without installing
it: a Discord server adds the demo application and gets an instance of its own, or a visitor clicks a button on
the portal and gets an anonymous one for the afternoon.

Nothing here is needed to run SLM. If you are installing it for your own community, read
[installing](../docs/installing.md) instead.

## Shape

One container, N+1 processes. Something in front terminates TLS and forwards everything to `demo-control`, which
routes by Host header:

| Host                | What answers                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| the apex origin     | the portal, the login broker, and the fleet page                        |
| `g-<guildId>.<dom>` | the instance belonging to that Discord server                           |
| `t-<slug>.<dom>`    | an anonymous instance; the unguessable slug is the whole access control |

`demo-control` is the same image and the same bundle as the app, run with a different command
(`pnpm run demo:control`). A fleet therefore cannot be provisioning a different build of SLM than the one it is
itself built from.

The proxy is in-process rather than a second router in front, because routing, the idle clock and wake-on-request
all want the same answer: the registry. Every request bumps its instance's `last_active_at`; a request for an
instance that is not running starts it, waits for it to answer, and then forwards.

That is also why the fleet asks so little of whatever is in front of it: one wildcard route to one port, for the
life of the deployment. Nothing out there ever learns that an individual instance exists, so provisioning and
reaping need no proxy reload, no config generation and no hook.

## Two kinds of instance

|             | `guild`                                          | `ephemeral`                   |
| ----------- | ------------------------------------------------ | ----------------------------- |
| Created by  | installing the Discord application               | "Try it now" on the portal    |
| Sign-in     | Discord, through the broker                      | any name, no password         |
| Permissions | a guild role you pick on first login             | everyone is an admin          |
| Lifetime    | deleted after 3 days unused; the bot then leaves | 4 hours, or 45 minutes unused |
| Cap         | 90                                               | 8, rate-limited per address   |

Both start from an empty database, so there is no production data anywhere in the fleet and nothing to anonymize.
Both run the emulated [sandbox server](../docs/sandbox_servers.md), which is what there is to demonstrate: the queue,
the votes and the in-game commands all work, against players who do not exist.

A guild instance is **not** a `DEMO=true` instance. It runs with real identities and real permissions, and only
its squad server is emulated. What it does not have is credentials of its own, which is what the next two sections
are about.

## Installing

The portal's install button points at `<apex>/install`, not straight at Discord. That is so the flow can carry a
`state` parameter, and so Discord has somewhere to send the installer back to.

The bot is added as soon as they authorize, which the gateway sees as `GUILD_CREATE` and provisions from. Their
browser then arrives at `<apex>/installed`, where the token exchange names the guild they just added the app to.
The control plane starts the instance, waits for it to answer, and signs them straight into it. Whichever of the
two arrives first provisions; the other finds the instance already there.

This matters because **the installer and the server's owner are usually not the same person**. Discord only lets
someone add an app to a server where they hold Manage Server, so the installer is exactly who should be
configuring the instance, but nothing in `GUILD_CREATE` says who they were. Reading it from the audit log would
mean asking for `VIEW_AUDIT_LOG` at install time, which the fleet does not do: it installs with `permissions=0`.
So the DM to the owner is the fallback, not the route.

The instance host is derivable from the guild id anyway, so none of this is access control. It is the difference
between landing on your demo and being told about it in a DM you may not receive.

## Signing in

Discord caps an application at 10 OAuth redirect URIs, and the fleet has up to 90 hosts. So no instance runs an
OAuth flow: they all bounce to one broker at the apex.

1. An unauthenticated request to `g-<guildId>.demo.<host>` redirects to `<apex>/go/<guildId>`.
2. The broker runs the OAuth flow, checks that you are in that Discord server, and reads your permissions in it.
3. It signs `{guildId, discordId, username, canConfigure}` with an Ed25519 key and sends you back to
   `/login/token` on the instance.
4. The instance checks the signature against a public key, that the token names its own guild, that it has not
   expired (60 seconds) and that it has not already been used, and signs you in.

The instance holds only the public key. It cannot mint a token, and a token minted for one instance is refused by
every other.

## Reading Discord

An instance in `DISCORD_MODE=proxy` holds no bot token. It asks the control plane, which runs the fleet's single
gateway session and scopes every answer to that instance's own guild.

That is not only a convenience. An instance with the fleet's bot token would run SLM's ordinary guild check and
make the application leave every other Discord server it is installed in. Ninety gateway sessions would also
spend the 1000 session-starts a day an application gets on respawns alone.

Role and membership changes are forwarded from the gateway into each instance, so permissions take effect when
they change rather than an hour later.

## First-login role pick

Nobody deployed a guild instance, so nobody set `SUPER_USERS` on it. Instead:

- Every member of the Discord server can sign in and look around.
- Anyone holding **Manage Server** in Discord has full access, always. That is the anti-lockout, and it is read
  live rather than recorded, so it follows the Discord role. Whoever installed the app held it at that moment,
  by Discord's own rule, but they can lose it afterwards like anyone else.
- The first Manage Server holder to sign in is asked once which guild role runs the instance. Their pick is
  written to the ordinary permissions config, and is edited from the settings page like any other role
  afterwards.

Coming through the install flow, that first person is the installer, and the dialog is waiting when they land.

## Running one

No reverse proxy ships with the fleet, and `docker-compose.demo-fleet.yaml` starts `demo-control` alone. Point
whatever already terminates TLS on the host at its port, with one route covering the apex and the wildcard.

What that proxy needs is a wildcard DNS record and a wildcard certificate. Both match a **single** label, which is
the one thing worth knowing before picking hostnames:

- `DEMO_BASE_DOMAIN=demo.example.com` puts instances at `g-<guildId>.demo.example.com`. That needs a `*.demo`
  record and a certificate of its own, which for a wildcard means an ACME DNS-01 challenge.
- `DEMO_BASE_DOMAIN=example.com` with `DEMO_HOST_PREFIX=slm-demo-` puts them at
  `slm-demo-g-<guildId>.example.com`, reusing an existing `*.example.com` record and certificate. Set
  `DEMO_APEX_ORIGIN` to a host of the fleet's own then, since `example.com` itself is somebody else's.

```sh
DEMO_BASE_DOMAIN=demo.example.com \
  docker compose -f docker-compose.demo-fleet.yaml up -d
```

`DEMO_APEX_ORIGIN` is how a browser reaches the portal, and everything about how the fleet is addressed from
outside follows from it: which host serves the portal, and the scheme and port every instance url is built with.
Get it wrong and logins redirect somewhere nothing is listening. It defaults to `https://` on `DEMO_BASE_DOMAIN`.

Set `DEMO_DISCORD_CLIENT_ID`, `DEMO_DISCORD_CLIENT_SECRET` and `DEMO_DISCORD_BOT_TOKEN` to the fleet's own Discord
application to turn the guild flow on. Without them the fleet serves the anonymous portal alone. The application
needs exactly two OAuth redirect URIs registered, `<DEMO_APEX_ORIGIN>/login/callback` and
`<DEMO_APEX_ORIGIN>/installed`, whatever the size of the fleet.

`DEMO_CLIENT_IP_HEADER` names the header the proxy in front is trusted to set to the real client address, which
is what the per-address limit on anonymous instances counts. Leave it unset and the socket address is used, which
behind any proxy is one bucket for the whole internet. Only name a header something **overwrites**: one that is
appended to, as `X-Forwarded-For` is, can be prefixed with anything by the client.

`DEMO_FLEET_TOKEN` gates a status page at `/fleet?token=...`. Leaving it unset means there is no such page: it
names running instances, and an anonymous instance's subdomain is the only thing keeping strangers out of it.

Every other setting has a default; `src/demo-control/env.ts` is the list.

## Trying it locally

The whole guild flow runs from a laptop with no tunnel. The bot's gateway session is outbound, and Discord's
OAuth redirect sends the _browser_ to `redirect_uri` rather than connecting to it, so localhost is reachable
because the browser is already there.

```sh
DEMO_BASE_DOMAIN=localtest.me      # wildcard DNS onto 127.0.0.1
DEMO_APEX_ORIGIN=http://localhost:8099
DEMO_CONTROL_PORT=8099
DEMO_GUILD_IDLE_TIMEOUT=30d        # reaping a guild instance makes the bot leave the server
```

Register `http://localhost:8099/login/callback` and `http://localhost:8099/installed` on the application, and
enable the Server Members intent: the bot asks for it, it is privileged, and the gateway login fails outright
without it.

Use a **separate Discord application** from the deployed fleet's. One bot token means two gateway sessions both
handling `GUILD_CREATE`, and the deployed control plane's boot reconcile would provision an instance for your
test server.

Two things that only misbehave over plain http: the bot really does DM the guild owner on install and on leave,
and the portal's "Back to your demo" cookie is `Secure`, so a browser drops it. Neither affects the guild flow.

## Capacity

Measured, on the bundle the image ships:

| Configuration     | RSS / instance | Fleet of 98 |
| ----------------- | -------------- | ----------- |
| Stock             | 601 MB         | ~52 GB      |
| With memory flags | 465 MB         | ~39 GB      |

The flags (`--max-semi-space-size=16 --max-old-space-size=1024`) are passed to every child by the spawner. Left
alone, V8 sizes its heap from the host's memory, so on a large box each instance grows to several times its
working set before it collects hard.

98 instances run warm on a 64GB box, so hibernation is headroom rather than a requirement. Wake-on-request exists
because the proxy needs it for a reaped-then-revisited instance anyway; no eviction policy is layered on top of it.

## What is left to decide

- The wording of the three Discord messages the fleet sends (welcome, at capacity, leaving) is placeholder. See
  `src/demo-control/messages.ts` and `src/messages/demo-fleet.messages.ts`.
- Where a crash-looped instance surfaces. It is logged and shown on the fleet page; nothing pages anyone.
