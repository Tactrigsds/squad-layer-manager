# Squad Layer Manager

A Tool for managing the upcoming layers of a squad server, and other things also.

It is currently the primary admin tool used by the Tactical Triggernomery server, for tasks like queueing layers to player, determining team balance and performing teamswaps, and basic administrative task like issueing warns, kicks, timeouts, etc.

Its primary focus, as its name suggests, is on managing upcoming layers, and for this it has a sophisticated system called _filters_ which allows users to fine-tune which layers should be played on the server, and to make it easier to find a layer to play.

## Try it

```sh
docker run --rm -p 3000:3000 -e DEMO=1 ghcr.io/tactrigsds/squad-layer-manager:latest
```

Type a name and you are in. A demo instance needs no configuration at all and arrives preseeded, on an emulated
squad server with a roster of players on it. It has no authentication, so keep it off the internet.

## Documentation

- [Installing](docs/installing.md) - Get SLM Running
- [Configuring](docs/configuring.md) - Configure SLM to work for your squad server
- [Layer data](docs/layer_data.md) - the layer artifact pair, how it is resolved, and building your own.
- [Contributing](CONTRIBUTING.md) - local dev setup, the test suites, and the pre-push hook.
