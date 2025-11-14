import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import type * as Config from '@/server/config'
import type pino from 'pino'
import * as LDB from './layer-db'

export type EffectiveColumnConfig = { effectiveColsConfig: LC.EffectiveColumnConfig }

export type LayerDb = { layerDb: () => LDB.LayerDb } & EffectiveColumnConfig

export type Logger = pino.Logger

export type Log = {
	log: Logger
}

export type Filters = {
	filters: Map<string, F.FilterEntity>
}

export type MatchHistory = {
	recentMatches: MH.MatchDetails[]
}
export type LayerItemsState = {
	layerItemsState: LQY.LayerItemsState
}
export type PublicConfig = {
	publicConfig: Config.PublicConfig
}

export type LayerQuery = LayerDb & Log & Filters & LayerItemsState
