# Squad Layer Manager

A tool to manage the upcoming layers of a squad server, and other things also.

It is currently the primary admin tool used by the Tactical Triggernometry server, for tasks like queueing layers to play, helping admins determine the current state of team balance, and performing teamswaps.

It also helps with basic administrative tasks like issuing warns, kicks, timeouts, etc. It integrates well with BattleMetrics, allowing you to quickly set player flags and navigate to player profiles, and it can leverage those flags as a way to categorize players for team balance or monitoring.

All of this can be done either through a web-based GUI, which authenticates against your Discord server, or with in-game commands.

Its primary focus, as its name suggests, is on managing upcoming layers, and for this it has a sophisticated system called _filters_, which allows users to fine-tune via logical expressions which layers should be played on the server, making it easier to find a layer to play. It also has a system called _repeat rules_ to prevent common mistakes like setting layers with repeat maps, factions, etc.

It ships with a layer scoring system developed by community member Zero, which distills a number of heuristics into numerical scores for each layer, one per attribute it measures, to indicate how fair the layer is likely to be.

TODO Some screenshots here, also a video

## Try it

Spin up a demo instance with no authentication:

```sh
docker run --rm -p 3000:3000 -e DEMO=1 ghcr.io/tactrigsds/squad-layer-manager:latest
```

## Documentation

- [Installing](docs/installing.md) - Get SLM Running
- [Configuring](docs/configuring.md) - Configure SLM to work for your squad server
- [Layer data](docs/layer_data.md) - the layer artifact pair, how it is resolved, and building your own.
- [Contributing](CONTRIBUTING.md) - local dev setup, the test suites, and the pre-push hook.
