// see the slm-dev-source-plugins vite plugin in vite.config.ts: the source of every plugins/ directory
// in dev, empty in a build. Declared here rather than in modules.d.ts, which tsconfig.node.json pulls
// into a project with no DOM lib; the types below reach client code.
declare module 'virtual:slm-dev-plugins' {
	import type { Manifest } from '@/models/plugins.models'
	import type { ClientModule } from '@/systems/plugins.client'

	export const manifests: Record<string, { default?: Manifest }>
	export const clients: Record<string, (() => Promise<{ default: ClientModule }>) | undefined>
}
