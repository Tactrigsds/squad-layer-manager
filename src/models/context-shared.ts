import type * as F from '@/models/filter.models'
import type * as LC from '@/models/layer-columns'
import type * as MH from '@/models/match-history.models'
import type pino from 'pino'
import type * as LDB from './layer-db'

const CtxSymbol = Symbol('context')
export type Ctx = {
	[CtxSymbol]: true
}
export function init(): Ctx {
	return {
		[CtxSymbol]: true,
	}
}
export function isCtx(ctx: any): ctx is Ctx {
	return ctx && ctx[CtxSymbol] === true
}

export type EffectiveColumnConfig = Ctx & { effectiveColsConfig: LC.EffectiveColumnConfig }

export type LayerDb = Ctx & { layerDb: () => LDB.LayerDb } & EffectiveColumnConfig

export type Logger = pino.Logger

export type Log = Ctx & {
	log: Logger
}

export type Filters = Ctx & {
	filters: Map<string, F.FilterEntity>
}

export type MatchHistory = Ctx & {
	recentMatches: MH.MatchDetails[]
}
export type LayerQuery = Ctx & LayerDb & Log & Filters
