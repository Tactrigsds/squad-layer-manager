// Registers OpenTelemetry's import-in-the-middle (IITM) loader hook. Must run via `node --import` (or
// NODE_OPTIONS) *before* the app's module graph is loaded, so instrumented packages are intercepted as
// they are imported.
//
// This has to be a separate file, and it has to call module.register(): @opentelemetry/instrumentation's
// hook.mjs only exports loader hooks (resolve/load/initialize). Passing it straight to `--import` just
// imports it for its (nonexistent) side effects, which silently instruments nothing -- the auto
// instrumentations then load fine and produce zero spans.
//
// Note that instrumentation can only patch packages that are *loaded as modules* at runtime. Anything
// inlined into the server bundle has no module load to intercept, so keep instrumented packages (and the
// otel packages themselves) in `dependencies` -- rolldown-server-prod.config.ts externalizes exactly
// `Object.keys(dependencies)` plus node builtins.
import { register } from 'node:module'

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
	data: {
		// Only third-party modules are ever instrumented, so keep IITM away from our own files. It rewrites
		// each module it wraps by parsing its source for exports, and under tsx it sees raw TypeScript: it
		// mis-parses `export namespace Foo {}` (src/models/otel-attrs.ts) and hands back a namespace whose
		// members are undefined, which crashes logs.ts at import time. Excluding every file: URL outside
		// node_modules covers both the tsx dev path and the prod bundle; `node:` builtins are not file:
		// URLs, so http/net/dns stay instrumented.
		exclude: [/^file:\/\/(?!.*\/node_modules\/)/],
	},
})
