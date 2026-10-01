# Learning how to use SLM

SLM is mostly learned inside the app, by using it. Start with the tutorials, then practise on the sandbox server.

## Tutorials

The tutorials walk through the server dashboard, where admins run a live server: the layer queue, votes, players and
team swaps. Open _Tutorials_ from the nav bar. SLM also offers them the first time a user opens a server's dashboard.

| Tutorial          | Length | Covers                                                                              |
| ----------------- | ------ | ----------------------------------------------------------------------------------- |
| The layer queue   | 10 min | reading and editing the queue, picking layers, filters and repeat rules, generation |
| Player management | 15 min | the activity log, match history, teams and groups, warns, kicks, timeouts and swaps |

Each tutorial runs on a sandbox server, so no action taken in it reaches a real server. A tutorial can be left and
resumed later, and replayed once finished. Follow them on a desktop, with a mouse and keyboard.

## Practising on the sandbox server

A fresh install comes with a server named _Sandbox_, attached to an emulated Squad server. Use it to try the queue,
votes and player actions without affecting real players. See [sandbox_servers.md](sandbox_servers.md).

## Tooltips

Tooltips can be found throughout the app. Hover over an unfamiliar button, icon or label to see more about it.

## In-game commands

The _Commands_ page in the nav bar lists every in-game command your install has, and how to use each one.

## Trying SLM without installing it

Run a demo instance with no authentication:

```sh
docker run --rm -p 3000:3000 -e DEMO=1 ghcr.io/tactrigsds/squad-layer-manager:latest
```

## Setting SLM up

To install SLM, see [installing.md](installing.md). To change how it behaves, such as vote timing or what SLM
announces in game, see [configuring.md](configuring.md).
