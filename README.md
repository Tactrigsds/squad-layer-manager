# Squad Layer Manager

SLM manages the upcoming layers on a Squad server, and covers a lot of day-to-day server admin alongside it.

It is the main admin tool of the Tactical Triggernometry server, used for queueing layers, reading the current state
of team balance, and running teamswaps. It also handles warns, kicks and timeouts, and it integrates with
BattleMetrics so you can set player flags and open player profiles without leaving the app. Those flags can then be
used to categorise players for team balance or monitoring.

Everything is available two ways: through a web GUI that authenticates against your Discord server, and through
in-game commands.

Layer management is the focus. _Filters_ narrow the playable set with logical expressions, which makes finding a
layer to play much quicker. _Repeat rules_ catch common mistakes like queueing the same map or faction twice in a
row.

SLM ships with a layer scoring system written by community member Zero. It reduces a set of heuristics to one score
per attribute it measures, as an indication of how fair a layer is likely to be.

TODO Some screenshots here, also a video

## Try it

Spin up a demo instance with no authentication:

```sh
docker run --rm -p 3000:3000 -e DEMO=1 ghcr.io/tactrigsds/squad-layer-manager:latest
```

## Documentation

- [Installing](docs/installing.md) - get SLM running
- [Configuring](docs/configuring.md) - configure SLM for your squad server
- [Layer data](docs/layer_data.md) - the layer artifact pair, how it is resolved, and building your own
- [Contributing](CONTRIBUTING.md) - local dev setup, the test suites, and the pre-push hook
