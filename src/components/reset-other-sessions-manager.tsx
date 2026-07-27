import React from 'react'

import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as USR_Msgs from '@/messages/users.messages'
import * as ConfigClient from '@/systems/config.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

// Renders nothing; while the current user has other actively-present clients (tabs / devices), shows a
// persistent, dismissable toast offering to reset them (clear their activity, mark them away). The
// toast dismisses itself once no other client is active -- e.g. after they're reset or disconnect.
export function ResetOtherSessionsManager() {
	const myClientId = Zus.useStore(ConfigClient.Store, (config) => config?.wsClientId)
	const loggedInUser = UsersClient.useLoggedInUser()
	const activeOtherCount = Zus.useStore(UPClient.Store, UPClient.Sel.activeOtherClientCount(loggedInUser?.discordId, myClientId))

	const toastIdRef = React.useRef<string | number | null>(null)

	React.useEffect(() => {
		if (activeOtherCount <= 0) {
			if (toastIdRef.current !== null) toast.dismiss(toastIdRef.current)
			toastIdRef.current = null
			return
		}
		const [message, opts] = USR_Msgs.otherSessionsActive(activeOtherCount).toast()
		toastIdRef.current = toast.warning(message, {
			...opts,
			id: toastIdRef.current ?? undefined,
			// infinite duration -- it stays until dismissed or the other sessions become inactive
			duration: Infinity,
			action: {
				label: USR_Msgs.resetOtherSessions().text(),
				onClick: () => UPClient.Actions.resetOtherClients(),
			},
		})
	}, [activeOtherCount])

	return null
}
