# Demo mode

`DEMO=1` runs SLM as a throwaway instance. It is the one configuration that needs no configuration: no Discord
app, no encryption key, no BattleMetrics token, no squad server, and no database to prepare. It exists so that
someone evaluating SLM, or reproducing a bug, can have a working instance in front of them in one command.

```sh
docker run --rm -p 3000:3000 -e DEMO=1 ghcr.io/tactrigsds/squad-layer-manager:latest
```

Then open `http://localhost:3000`, type a name, and you are in.

## Do not point it at anything real

**A demo instance has no authentication and no permissions.** Anyone who can reach it can sign in as anyone, and
everyone who signs in holds every permission. Run it on your own machine, or somewhere that is not reachable from
the internet. Nothing in it is meant to survive: it holds no credentials worth having, and its encryption key is
the public one this repository ships.

## What DEMO fills in

It supplies a default for every variable that would otherwise stop the boot, and only for the ones left unset --
setting any of them yourself still wins.

| variable                  | demo default               | why                                                  |
| ------------------------- | -------------------------- | ---------------------------------------------------- |
| `NODE_ENV`                | `production`               | serves the built client                              |
| `QUERY_PARAM_AUTH_BYPASS` | `true`                     | turns off discord auth: this is what "no auth" means |
| `SETTINGS_ENCRYPTION_KEY` | the public development key | there are no real connection secrets to protect      |
| `OTEL_ENABLED`            | `false`                    | nothing is listening on the collector endpoint       |
| `DISCORD_ENABLED`         | `false`                    | there is no discord app                              |
| `DISCORD_*`               | placeholders               | still parsed even with the integration off           |

Everything else already has a default that suits a demo: the database is created at `./data/db.sqlite3` and
migrated on the way up, and the layer artifacts ship in the image.

## Signing in

With discord auth off, a username is the whole identity. `/` serves a form asking for one; posting it creates
that user (if they are new) and signs you in. The same name is the same person across restarts.

`?login=<username>` still works and skips the form, but only for a user who already exists -- it is the
dev-instance shortcut (see [dev_instances.md](dev_instances.md)), and an unknown name simply leaves you on the
form rather than failing.

## The world

A demo gets the same [sandbox server](sandbox_servers.md) a fresh install gets: a squad server SLM emulates
in-process, already enabled and already the default. Demo mode additionally connects a dozen players to it on
every boot, one of them an in-game admin, so the dashboard has a roster to show. The world is in memory, so a
restart empties it and refills it; drive it yourself from **Server Actions -> Sandbox Controls**.

## No auth without demo

`QUERY_PARAM_AUTH_BYPASS` is what actually turns discord auth off, and the login form comes with it, so a dev
instance gets the form too. `DEMO` is the difference between "no auth" and "no configuration": it is also what
grants every visitor every permission, which a dev instance does not do (there, access still comes from
`SUPER_USERS`).

Outside demo mode, `QUERY_PARAM_AUTH_BYPASS=true` is still refused when `NODE_ENV=production`.
