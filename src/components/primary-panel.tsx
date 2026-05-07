import { StartActivityInteraction } from '@/components/activity.tsx'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CardDescription } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import * as RbSyncState from '@/lib/rollback-synced-state'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models.ts'
import * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'
import * as RBAC from '@/rbac.models.ts'
import * as ConfigClient from '@/systems/config.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as LQYClient from '@/systems/layer-queries.client.ts'
import * as QD from '@/systems/queue-dashboard.client'
import * as RbacClient from '@/systems/rbac.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { RepeatViolationDisplay } from './constraint-matches-indicator.tsx'
import { LayerList } from './layer-list.tsx'
import { MatchHistoryPanelContent } from './match-history-panel'
import PoolConfigurationPopover from './server-settings-popover.tsx'
import ShortLayerName from './short-layer-name.tsx'

import UserPresencePanel from './user-presence-panel.tsx'

export default function PrimaryPanel() {
	type Tab = 'layer-queue' | 'teams'
	const [tab, setTab] = React.useState<Tab>('layer-queue')
	return (
		<Card className="flex flex-col flex-1 min-h-0">
			<ScrollArea className="flex-1">
				<MatchHistoryPanelContent />
				<Separator />
				<CardHeader className="flex flex-row items-center justify-between">
					<CardTitle>Recent Users</CardTitle>
					<UserPresencePanel />
				</CardHeader>
				<Separator />
			</ScrollArea>
		</Card>
	)
}
