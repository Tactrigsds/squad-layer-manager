import * as Rx from '@/lib/rxjs'
import type * as SETTINGS from '@/models/settings.models'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base.ts'
import * as LayerEngine from '@/systems/layer-engine.server'
import * as Settings from '@/systems/settings.server'

import * as Env from './env.ts'

// Delivers the public, deploy-time config to every connected client. There is no longer a JSONC config file:
// the former deploy constants live in env vars (env.ts) and the admin-tunable `layerTable` lives in global
// settings (settings.server.ts). This module just assembles and broadcasts the derived public view.

// the integration flags are read from the env rather than asked of the systems that own them: this module is set
// up before they are, and their answer is a deploy-time constant either way
const envBuilder = Env.getEnvBuilder({
	...Env.groups.general,
	...Env.groups.squadcalc,
	DISCORD_ENABLED: Env.groups.discord.DISCORD_ENABLED,
	BM_ENABLED: Env.groups.battlemetrics.BM_ENABLED,
	SQUADBROWSER_ENABLED: Env.groups.squadbrowser.SQUADBROWSER_ENABLED,
})
export let ENV!: ReturnType<typeof envBuilder>

// ============================== public, static config (never changes for the lifetime of the process) ==============================

// Where the product points when a deployment hasn't named somewhere of its own. A fork sets PUBLIC_REPO_URL /
// PUBLIC_ISSUES_URL / PUBLIC_HELP_URL; everyone else gets upstream, which is better than no link at all.
export const DEFAULT_REPO_URL = 'https://github.com/Tactrigsds/squad-layer-manager'
const DEFAULT_ISSUES_URL = `${DEFAULT_REPO_URL}/issues`
const DEFAULT_HELP_URL = 'https://discord.gg/U2ywQy48H'

export type PublicConfig = {
	isProduction: boolean
	PUBLIC_GIT_BRANCH: string
	PUBLIC_GIT_SHA: string
	PUBLIC_SQUADCALC_URL: string
	repoUrl: string
	issuesUrl: string
	helpUrl: string
	layerTable: SETTINGS.GlobalSettings['layerTable']
	layerGeneration: SETTINGS.GlobalSettings['layerGeneration']
	layersVersion: string
	// Whether it is worth the client storing the decompressed layer artifact in OPFS. It is ~235MB, and the write
	// costs more than fetching and inflating it put together, so it only pays for itself where a later page load
	// reads it back. e2e is the case where none ever does: playwright gives every test a fresh browser profile.
	cacheLayerArtifact: boolean
	// what this deployment is wired up to, so the client hides the affordances that would resolve to nothing
	integrations: { battlemetrics: boolean; discord: boolean; squadBrowser: boolean }
}

export type PublicConfigForClient = PublicConfig & { wsClientId: string }

const publicConfig$ = new Rx.ReplaySubject<PublicConfig>(1)

export function pushPublicConfig() {
	publicConfig$.next({
		isProduction: ENV.NODE_ENV === 'production',
		PUBLIC_GIT_BRANCH: ENV.PUBLIC_GIT_BRANCH,
		PUBLIC_GIT_SHA: ENV.PUBLIC_GIT_SHA,
		PUBLIC_SQUADCALC_URL: ENV.PUBLIC_SQUADCALC_URL,
		repoUrl: ENV.PUBLIC_REPO_URL ?? DEFAULT_REPO_URL,
		issuesUrl: ENV.PUBLIC_ISSUES_URL ?? DEFAULT_ISSUES_URL,
		helpUrl: ENV.PUBLIC_HELP_URL ?? DEFAULT_HELP_URL,
		layerTable: Settings.GLOBAL_SETTINGS.layerTable,
		layerGeneration: Settings.GLOBAL_SETTINGS.layerGeneration,
		layersVersion: LayerEngine.layersVersion,
		// a dev instance is reloaded against the same profile all day, so it wants the cache; only e2e does not
		cacheLayerArtifact: ENV.NODE_ENV !== 'test',
		integrations: { battlemetrics: ENV.BM_ENABLED, discord: ENV.DISCORD_ENABLED, squadBrowser: ENV.SQUADBROWSER_ENABLED },
	})
}

// called once from main.ts, after LayerEngine.setup() and Settings.setup() have resolved. Re-pushes whenever global
// settings change so `layerTable`/`layerGeneration` edits live-update every client without a restart.
export function setup() {
	ENV = envBuilder()
	pushPublicConfig()
	Settings.settings$.pipe(Rx.filter((e) => e.scope === 'global')).subscribe(() => pushPublicConfig())
}

const module = initModule('config')
const orpcBase = getOrpcBase(module)

export const router = {
	watchConfig: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context: ctx, signal }) {
		yield* Rx.Ext.toAsyncGenerator(
			publicConfig$.pipe(
				Rx.map((base): PublicConfigForClient => ({ ...base, wsClientId: ctx.wsClientId })),
				Rx.Ext.withAbortSignal(signal!),
			),
		)
	}),
}
