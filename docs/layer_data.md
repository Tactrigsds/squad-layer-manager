# Layer data

SLM depends on a pair of artifacts, always of the same version:

- `layers_v<version>.bin.gz` - every possible layer configuration (layer + factions + units) in a columnar format,
  plus the scores attributed to each layer.
- `layer-data_v<version>.json` - the components (maps, factions, units, extra-column definitions) that the table's
  encoded values refer to.

Neither half is usable without the other, and a table read against the wrong components resolves to the wrong layers
without reporting an error. So the two are only ever used as a pair, from the same directory and at the same
version. Half a pair is a startup error.

Both are checked in under `assets/layers` and ship inside the docker image, so the app boots as-is with nothing to
download.

To run a different layer version, drop a complete pair into `data/`, the directory a deployment mounts. Any complete
pair there wins over the one in the image, including an older one, so moving a deployment between layer versions is
a matter of dropping in files and restarting. `<version>` is parsed as semver, and the highest one in the winning
directory is used unless `LAYERS_VERSION` pins a version. `LAYERS_DIR` adds a directory that is searched ahead of
both.

To build your own pair, with different scoring, extra columns, or different layers and game versions, see
`src/scripts/preprocess.ts` (`pnpm preprocess`). It writes both halves into `assets/layers`, or into
`LAYERS_OUTPUT_DIR` if that is set.

## Mod support

Not implemented yet. Parts of SLM rely on the structure of vanilla layers.
