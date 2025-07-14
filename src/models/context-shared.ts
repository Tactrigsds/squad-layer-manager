import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as MH from '@/models/match-history.models'
import type pino from 'pino'
import { LayerDb } from './layer-db'

export type EffectiveColumnConfig = { effectiveColsConfig: LC.EffectiveColumnConfig }

export type Layers = { layerDb: () => LayerDb } & EffectiveColumnConfig

export type Logger = pino.Logger

export type Log = {
	log: Logger
}

export type Filters = {
	filters: F.FilterEntity[]
}

export type MatchHistory = {
	recentMatches: MH.MatchDetails[]
}

export type LayerQuery = Layers & Log & Filters
