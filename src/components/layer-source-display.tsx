import * as Icons from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as LL_Msgs from '@/messages/layer-list.messages'
import type * as LL from '@/models/layer-list.models'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'

import { Avatar } from './ui/avatar'
import { UserAvatar } from './user-avatar'

export default function LayerSourceDisplay(props: { source: LL.Source }) {
	// a plugin's display name where the install still has it, so the tooltip does not read as an id. An
	// uninstalled plugin leaves items behind, so falling back to the id matters.
	const pluginId = props.source.type === 'plugin' ? props.source.pluginId : undefined
	const pluginName = Zus.useStore(PluginsClient.Store, (s) => (pluginId ? s.manifests[pluginId]?.name : undefined))
	const renderIcon = (displayName: string, backgroundColor: string, icon: React.ReactNode) => (
		<Tooltip delayDuration={0}>
			<TooltipTrigger>
				<Avatar style={{ backgroundColor }} className="h-6 w-6">
					{icon}
				</Avatar>
			</TooltipTrigger>
			<TooltipContent className="bg-secondary text-secondary-foreground">{displayName}</TooltipContent>
		</Tooltip>
	)

	switch (props.source.type) {
		case 'gameserver':
			return renderIcon(LL_Msgs.sourceNames.gameserver, '#6366f1', <Icons.Server />)
		case 'unknown':
			return renderIcon(LL_Msgs.sourceNames.unknown, '#64748b', <Icons.MessageCircleQuestion />)
		case 'generated':
			return renderIcon(LL_Msgs.sourceNames.generated, '#059669', <Icons.Dices />)
		case 'ingame-vote':
			return renderIcon(LL_Msgs.sourceNames['ingame-vote'], '#d97706', <Icons.Vote />)
		case 'plugin':
			return renderIcon(tr.text(LL_Msgs.setByPlugin(pluginName ?? props.source.pluginId)), '#7c3aed', <Icons.Plug />)
		case 'manual':
			return <UserAvatar userId={props.source.userId} label={tr.text(LL_Msgs.setByLabel())} />
		default:
			assertNever(props.source)
	}
}
