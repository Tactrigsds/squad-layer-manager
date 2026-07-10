import * as Arr from '@/lib/array'
import * as DH from '@/lib/display-helpers'
import * as ItemMut from '@/lib/item-mutations'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import * as SetUtils from '@/lib/set'
import * as BAL from '@/models/balance-triggers.models'
import * as BM from '@/models/battlemetrics.models'
import * as CHAT from '@/models/chat.models'
import * as CMD from '@/models/command.models'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as EFB from '@/models/editable-filter-builders'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import * as SE from '@/models/server-events.models'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswitches.models'
import * as UP from '@/models/user-presence'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'
import * as Config from '@/server/config.server'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import * as Battlemetrics from '@/systems/battlemetrics.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Cli from '@/systems/cli.server'
import * as Commands from '@/systems/commands.server'
import * as Discord from '@/systems/discord.server'
import * as Fastify from '@/systems/fastify.server'
import * as FilterEntity from '@/systems/filter-entity.server'
import * as LayerDb from '@/systems/layer-db.server'
import * as LayerQueries from '@/systems/layer-queries.server'
import * as LayerQueue from '@/systems/layer-queue.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as Rbac from '@/systems/rbac.server'
import * as Sessions from '@/systems/sessions.server'
import * as Settings from '@/systems/settings.server'
import * as SquadLogsReceiver from '@/systems/squad-logs-receiver.server'
import * as SquadRcon from '@/systems/squad-rcon.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Teamswitches from '@/systems/teamswitches.server'
import * as UserPresence from '@/systems/user-presence.server'
import * as Users from '@/systems/users.server'
import * as Vote from '@/systems/vote.server'
import * as WsSessionSys from '@/systems/ws-session.server'

import * as Im from 'immer'
import * as Rx from 'rxjs'
import * as superjson from 'superjson'
import { z } from 'zod'

const namespaces = {
	// server core
	C,
	Config,
	DB,
	Env,

	// systems
	Battlemetrics,
	CleanupSys,
	Cli,
	Commands,
	Discord,
	Fastify,
	FilterEntity,
	LayerDb,
	LayerQueries,
	LayerQueue,
	MatchHistory,
	Rbac,
	Sessions,
	Settings,
	SquadLogsReceiver,
	SquadRcon,
	SquadServer,
	Teamswitches,
	UserPresence,
	Users,
	Vote,
	WsSessionSys,

	// models
	BAL,
	BM,
	CHAT,
	CMD,
	CS,
	CB,
	EFB,
	FB,
	F,
	LC,
	LL,
	LQY,
	L,
	MH,
	SE,
	SS,
	SETTINGS,
	SLL,
	SM,
	TSW,
	UP,
	USR,
	V,

	// lib
	Arr,
	DH,
	ItemMut,
	MapUtils,
	Obj,
	ODSM,
	SetUtils,

	// misc
	Im,
	Rx,
	superjson,
	z,
}

const w = global as any
Object.assign(w, namespaces)

w.debug__setTicketOutcome = (team1: number, team2: number) => {
	SquadServer.globalState.debug__ticketOutcome = { team1, team2 }
}
console.log('-------- DEVELOPER CONSOLE LOADED --------')
