---
audience: operators
kind: changed
---

SLM runs as the unprivileged `node` user inside its container. The first start after upgrading hands the `data`
directory to that user, so no step is needed.

Session ids are stored hashed, so a copy of the database or a backup no longer holds a usable sign-in. Nobody is signed
out by the upgrade.

Grafana now asks everyone to sign in, and accepts connections from the machine SLM runs on only. An existing install
keeps its Grafana admin account and password. To open Grafana from another machine, forward port 3001 over SSH with
`ssh -L 3001:localhost:3001 <your server>`, or put it behind a reverse proxy on the same machine.
