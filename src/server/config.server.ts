import { toAsyncGenerator, withAbortSignal } from '@/lib/async'
import type * as SETTINGS from '@/models/settings.models'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base.ts'
import * as LayerDb from '@/systems/layer-db.server'
import * as Settings from '@/systems/settings.server'
import * as Rx from 'rxjs'
import * as Env from './env.ts'

// Delivers the public, deploy-time config to every connected client. There is no longer a JSONC config file:
// the former deploy constants live in env vars (env.ts) and the admin-tunable `layerTable` lives in global
// settings (settings.server.ts). This module just assembles and broadcasts the derived public view.

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.squadcalc })
export let ENV!: ReturnType<typeof envBuilder>

// ============================== public, static config (never changes for the lifetime of the process) ==============================

export type PublicConfig = {
	isProduction: boolean
	PUBLIC_GIT_BRANCH: string
	PUBLIC_GIT_SHA: string
	PUBLIC_SQUADCALC_URL: string
	repoUrl: string | undefined
	issuesUrl: string | undefined
	layerTable: SETTINGS.GlobalSettings['layerTable']
	extraColumnsConfig: typeof LayerDb.LAYER_DB_CONFIG
	layersVersion: string
}

export type PublicConfigForClient = PublicConfig & { wsClientId: string }

const publicConfig$ = new Rx.ReplaySubject<PublicConfig>(1)

export function pushPublicConfig() {
	publicConfig$.next({
		isProduction: ENV.NODE_ENV === 'production',
		PUBLIC_GIT_BRANCH: ENV.PUBLIC_GIT_BRANCH,
		PUBLIC_GIT_SHA: ENV.PUBLIC_GIT_SHA,
		PUBLIC_SQUADCALC_URL: ENV.PUBLIC_SQUADCALC_URL,
		repoUrl: ENV.PUBLIC_REPO_URL,
		issuesUrl: ENV.PUBLIC_ISSUES_URL,
		layerTable: Settings.GLOBAL_SETTINGS.layerTable,
		extraColumnsConfig: LayerDb.LAYER_DB_CONFIG,
		layersVersion: LayerDb.layersVersion,
	})
}

// called once from main.ts, after LayerDb.setup() and Settings.setup() have resolved. Re-pushes whenever global
// settings change so `layerTable` edits live-update every client's column config without a restart.
export function setup() {
	ENV = envBuilder()
	pushPublicConfig()
	Settings.settings$.pipe(Rx.filter((e) => e.scope === 'global')).subscribe(() => pushPublicConfig())
}

const module = initModule('config')
const orpcBase = getOrpcBase(module)

export const router = {
	watchConfig: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context: ctx, signal }) {
		yield* toAsyncGenerator(
			publicConfig$.pipe(
				Rx.map((base): PublicConfigForClient => ({ ...base, wsClientId: ctx.wsClientId })),
				withAbortSignal(signal!),
			),
		)
	}),
}
