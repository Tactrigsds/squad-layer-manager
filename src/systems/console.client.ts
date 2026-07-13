import { frameManager } from '@/frames/frame-manager'
import * as Arr from '@/lib/array'
import * as DH from '@/lib/display-helpers'
import * as ItemMut from '@/lib/item-mutations'
import * as MapUtils from '@/lib/map'
import * as Obj from '@/lib/object'
import * as ODSM from '@/lib/odsm'
import * as RSel from '@/lib/reselect'
import * as SetUtils from '@/lib/set'
import * as ZusUtils from '@/lib/zustand'
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
import * as TSW from '@/models/teamswaps.models'
import * as UP from '@/models/user-presence'
import * as USR from '@/models/users.models'
import * as V from '@/models/vote.models'
import * as RPC from '@/orpc.client'
import * as AppRoutesClient from '@/systems/app-routes.client'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import * as ConfigClient from '@/systems/config.client'
import * as DiscordClient from '@/systems/discord.client'
import * as FeatureFlags from '@/systems/feature-flags.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerInfoDialogClient from '@/systems/layer-info-dialog.client'
import * as LQClient from '@/systems/layer-queries.client'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as LoggedInUserClient from '@/systems/logged-in-user.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as PartsSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as TSWClient from '@/systems/teamswaps.client'
import * as ThemeClient from '@/systems/theme.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as VoteClient from '@/systems/vote.client'

import * as Im from 'immer'
import * as Rx from 'rxjs'
import { z } from 'zod'

const namespaces = {
	// systems
	AppRoutesClient,
	BattlemetricsClient,
	ClientOnlySettings,
	ConfigClient,
	DiscordClient,
	FeatureFlags,
	FilterEntityClient,
	LayerInfoDialogClient,
	LQClient,
	LayerQueueClient,
	LoggedInUserClient,
	MatchHistoryClient,
	PartsSys,
	RbacClient,
	SettingsClient,
	SquadServerClient,
	ThemeClient,
	TSWClient,
	UPClient,
	UsersClient,
	VoteClient,

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
	RSel,
	SetUtils,
	ZusUtils,

	// misc
	Im,
	Rx,
	z,
	RPC,
	frameManager,
}

const w = window as any
Object.assign(w, namespaces)

console.log('-------- DEVELOPER CONSOLE LOADED --------')
