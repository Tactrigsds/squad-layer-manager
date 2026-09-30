# Squad Layer Manager (SLM)

SLM is a tool for managing upcoming layers on a Squad server, and other things also.

**Documentation: https://tactrigsds.github.io/squad-layer-manager/**

It is the main admin tool of the Tactical Triggernometry server, used for queueing layers, reading the current state
of team balance, and running teamswaps. It also issues warns, kicks and timeouts, and it integrates with
BattleMetrics so you can set player flags and open player profiles without leaving the app. Those flags can then be
used to categorise players for team balance or monitoring.

Everything is available in two ways: through a web GUI that authenticates against your Discord server via OAuth, and
through in-game commands.

Layer management is the primary focus of SLM. _Filters_ narrow the playable set with logical expressions, which
makes it easier to find a layer to play. _Repeat rules_ catch common mistakes like queueing the same map or faction
twice in a row.

SLM ships with a layer scoring system written by community member Zero. It reduces a set of heuristics to one score
per measured attribute. Each score indicates how fair a layer is likely to be.

TODO Some screenshots here, also a video

## Try it

Spin up a demo instance with no authentication:

```sh
docker run --rm -p 3000:3000 -e DEMO=1 ghcr.io/tactrigsds/squad-layer-manager:latest
```

## Documentation

Read these pages on the [documentation site](https://tactrigsds.github.io/squad-layer-manager/), which adds search,
or as markdown here:

- [Installing](docs/installing.md): get SLM running
- [Configuring](docs/configuring.md): configure SLM for your squad server
- [Learning how to use SLM](docs/server_dashboard.md): the in-app tutorials for running a live server
- [Backups and restoring](docs/backups.md): what gets backed up, uploading it offsite, and putting one back
- [Server agent](docs/server_agent.md): stream a game host's logs and proxy its RCON to SLM
- [Layer data](docs/layer_data.md): the layer artifact pair, how it is resolved, and building your own
- [Writing a plugin](docs/writing_plugins.md): the plugin contract, and packing one for admins to install
- [Contributing](CONTRIBUTING.md): local dev setup, the test suites, and the pre-push hook
