# The Layer data

The app depends on a _pair_ of artifacts, always of the same version:

- `layers_v<version>.bin.gz` -- a set of all possible layer configurations (layer + factions + units) in a columnar
  format, plus any scoring we attribute to each layer.
- `layer-data_v<version>.json` -- the components (maps, factions, units, extra-column definitions) the table's
  encoded values refer to.

Neither is any use without the other -- a table read against the wrong components silently resolves to the wrong
layers -- so the two are only ever treated as a pair, and only when they sit in the same directory under the same
version. Half a pair is a startup error rather than something the app quietly works around.

Both are checked in under `assets/layers` and ship inside the docker image, so the app boots as-is and there is
nothing to download.

To run a different layer version than the one the image ships, drop a complete pair into `data/` (the directory a
deployment mounts). **Any** complete pair there is preferred over the one in the image, including an older one, so
moving a running deployment between layer versions is a matter of dropping files into the mount and restarting.
`<version>` is parsed as semver and the highest one in the winning directory is used, unless `LAYERS_VERSION` pins
one. `LAYERS_DIR` adds a directory that is searched ahead of both.

You can build your own pair with alternate scoring, additional columns different layers/game versions: see `src/scripts/preprocess.ts`
(`pnpm preprocess`), which writes both halves into `assets/layers` (override with `LAYERS_OUTPUT_DIR`).

## Mod Support

Mod support is planned but not yet implemented, as there are SLM internals that rigidly rely on the structure of vanilla layers to work.
