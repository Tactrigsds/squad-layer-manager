// Source maps for our own code, not for dependencies. Must run via `node --import` before the app's module graph
// loads: Node caches a module's source map data when it compiles the module, so the setting has to be in place by
// then, and `--enable-source-maps` has no way to express the exclusion.
//
// The server externalizes every runtime dependency (see rolldown-server-prod.config.ts), so it compiles ~950
// node_modules files against ~15 of its own chunks, and their map data dominates. Measured over a representative
// slice of those packages, excluding them costs exactly what turning source maps off entirely costs -- and costs
// nothing in readability, because the frames worth reading are ours.
import module from 'node:module'

module.setSourceMapsSupport(true, { nodeModules: false, generatedCode: false })
