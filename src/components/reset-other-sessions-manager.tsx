import * as ZusUtils from '@/lib/zustand'
import * as ConfigClient from '@/systems/config.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import React from 'react'
import { toast } from 'sonner'

// Renders nothing; while the current user has other actively-present clients (tabs / devices), shows a
// persistent, dismissable toast offering to reset them (clear their activity, mark them away). The
// toast dismisses itself once no other client is active -- e.g. after they're reset or disconnect.
export function ResetOtherSessionsManager() {
	const myClientId = ZusUtils.useStore(ConfigClient.Store, config => config?.wsClientId)
	const loggedInUser = UsersClient.useLoggedInUser()
	const activeOtherCount = ZusUtils.useStore(
		UPClient.Store,
		UPClient.Sel.activeOtherClientCount(loggedInUser?.discordId, myClientId),
	)

	const toastIdRef = React.useRef<string | number | null>(null)

	React.useEffect(() => {
		if (activeOtherCount <= 0) {
			if (toastIdRef.current !== null) toast.dismiss(toastIdRef.current)
			toastIdRef.current = null
			return
		}
		const description = `You're active in ${activeOtherCount} other session${activeOtherCount > 1 ? 's' : ''}.`
		toastIdRef.current = toast('Other sessions active', {
			id: toastIdRef.current ?? undefined,
			description,
			// infinite duration -- it stays until dismissed or the other sessions become inactive
			duration: Infinity,
			action: {
				label: 'Reset them',
				onClick: () => UPClient.Actions.resetOtherClients(),
			},
		})
	}, [activeOtherCount])

	return null
}
