// How a packaged plugin reaches SLM without a copy of SLM in its bundle. The host publishes its own
// module namespaces on one global, and every `slm/*` (and shared-package) specifier a plugin bundle
// imports resolves to a generated shim module that re-exports from it. The server installs the shims
// as a node module hook (plugin-api-registry.server.ts); the browser resolves them to /plugin-api/*
// through the import map in index.html.
//
// One instance of each shared package matters: two zods make `configSchema instanceof z.ZodObject`
// false, and two Reacts break hooks.

export const API_GLOBAL = '__SLM_PLUGIN_API__'
// node resolves slm/* to this scheme, which nothing else claims, so the load hook owns it outright
export const SHIM_SCHEME = 'slm-api:'
export const SHIM_ROUTE_PREFIX = '/plugin-api/'

export const SHARED_PACKAGES = [
	'rxjs',
	'zod',
	'drizzle-orm',
	'drizzle-orm/sqlite-core',
	'react',
	'react/jsx-runtime',
	'@orpc/server',
	'@orpc/client',
] as const

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// Bindings are declared and then exported through a clause rather than as `export const <name>`:
// an export clause takes any IdentifierName, so reserved words survive (zod really does export
// `catch`), and a name that is not an identifier at all can still be exported as a string.
export function shimSource(specifier: string, names: readonly string[]): string {
	const lines = [
		`const m = globalThis[${JSON.stringify(API_GLOBAL)}]?.[${JSON.stringify(specifier)}];`,
		`if (!m) throw new Error(${JSON.stringify(`${specifier} is not available in this environment`)});`,
	]
	const clause = names.map((name, i) => {
		lines.push(`const _${i} = m[${JSON.stringify(name)}];`)
		return `_${i} as ${IDENT.test(name) ? name : JSON.stringify(name)}`
	})
	if (clause.length > 0) lines.push(`export { ${clause.join(', ')} };`)
	return lines.join('\n')
}

// The import map needs one line per shared package but only a single `slm/` prefix mapping, so the
// two live under different route roots: slm/models/layer -> /plugin-api/slm/models/layer, and
// react/jsx-runtime -> /plugin-api/pkg/react/jsx-runtime.
export function specifierToRoute(specifier: string): string {
	return specifier.startsWith('slm/') ? `${SHIM_ROUTE_PREFIX}${specifier}` : `${SHIM_ROUTE_PREFIX}pkg/${specifier}`
}

export function routeToSpecifier(subPath: string): string | null {
	if (subPath.startsWith('slm/')) return subPath
	if (subPath.startsWith('pkg/')) return subPath.slice('pkg/'.length)
	return null
}
