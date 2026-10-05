# Learning how to use SLM

SLM is mostly learned inside the app, by using it. Start with the tutorials, then practise on the sandbox server.

## Tutorials

The tutorials walk through the server dashboard on a sandbox server of their own. Open _Tutorials_ from the nav bar.
SLM also offers them the first time a user opens a server's dashboard. [Learning SLM](../features/learning_slm.md)
describes each tutorial and how to move through one.

## Practising on the sandbox server

A fresh install comes with a server named _Sandbox_, attached to an emulated Squad server. Use it to try the queue,
votes and player actions without affecting real players. See [sandbox_servers.md](operations/sandbox_servers.md).

## Tooltips

Tooltips can be found throughout the app. Hover over an unfamiliar button, icon or label to see more about it.

## In-game commands

The _Commands_ page in the nav bar lists every in-game command your install has, and how to use each one.

## Trying SLM without installing it

Run a demo instance with no authentication:

```sh
docker run --rm -p 127.0.0.1:3000:3000 -e DEMO=1 ghcr.io/tactrigsds/squad-layer-manager:latest
```

## Setting SLM up

To install SLM, see [installing.md](../installing.md). To change how it behaves, such as vote timing or what SLM
announces in game, see [configuring.md](configuring/overview.md).
