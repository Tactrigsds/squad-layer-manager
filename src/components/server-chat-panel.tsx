import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { TeamIndicator } from '@/lib/display-helpers-teams.tsx'
import * as DH from '@/lib/display-helpers.ts'
import * as ST from '@/lib/state-tree.ts'
import * as BAL from '@/models/balance-triggers.models'
import * as SLL from '@/models/shared-layer-list'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client.ts'
import { GlobalSettingsStore } from '@/systems.client/global-settings.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as ServerSettingsClient from '@/systems.client/server-settings.client.ts'
import * as SLLClient from '@/systems.client/shared-layer-list.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import BalanceTriggerAlert from './balance-trigger-alert.tsx'
import CurrentLayerCard from './current-layer-card.tsx'
import { LayerList, StartActivityInteraction } from './layer-list.tsx'
import PoolConfigurationPopover from './server-settings-popover.tsx'
import { Label } from './ui/label.tsx'
import { Separator } from './ui/separator.tsx'
import { Switch } from './ui/switch.tsx'
import TabsList from './ui/tabs-list.tsx'
import UserPresencePanel from './user-presence-panel.tsx'

export default function ServerChatPanel() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					Server Chat
				</CardTitle>
			</CardHeader>
			<CardContent>
			</CardContent>
		</Card>
	)
}
