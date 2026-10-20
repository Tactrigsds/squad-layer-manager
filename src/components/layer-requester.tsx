import { cn } from '@/lib/utils'
import * as BB_Msgs from '@/messages/backburner.messages'
import type * as USR from '@/models/users.models'
import { tr } from '@/systems/messages.client'
import * as PlayerNamesClient from '@/systems/player-names.client'

import { UserLabel } from './user-avatar'

/** Who made a layer request: the SLM user, else the player by username, else by the steam id itself. */
export function LayerRequester(props: { requester: USR.GuiOrChatUserId; className?: string }) {
	const { requester } = props
	const steamId = requester.discordId === undefined ? requester.steamId : undefined
	const username = PlayerNamesClient.usePlayerUsername(steamId === undefined ? undefined : { steam: steamId })

	if (requester.discordId !== undefined) return <UserLabel userId={requester.discordId} />
	const name = username ?? (steamId ? `steam:${steamId}` : tr.text(BB_Msgs.unknownRequester()))
	return (
		<span className={cn('text-xs', props.className)} title={steamId ? `steam:${steamId}` : undefined}>
			{name}
		</span>
	)
}
