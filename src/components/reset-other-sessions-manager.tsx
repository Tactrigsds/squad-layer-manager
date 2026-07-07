import { ToastAction } from '@/components/ui/toast'
import { toast } from '@/hooks/use-toast'
import * as ZusUtils from '@/lib/zustand'
import * as ConfigClient from '@/systems/config.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import React from 'react'

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

	const toastRef = React.useRef<ReturnType<typeof toast> | null>(null)

	React.useEffect(() => {
		if (activeOtherCount <= 0) {
			toastRef.current?.dismiss()
			toastRef.current = null
			return
		}
		const description = `You're active in ${activeOtherCount} other session${activeOtherCount > 1 ? 's' : ''}.`
		if (toastRef.current) {
			toastRef.current.update({ id: toastRef.current.id, description })
			return
		}
		toastRef.current = toast({
			title: 'Other sessions active',
			description,
			// infinite duration -- it stays until dismissed or the other sessions become inactive
			duration: Infinity,
			action: (
				<ToastAction altText="Reset my other sessions" onClick={() => UPClient.Actions.resetOtherClients()}>
					Reset them
				</ToastAction>
			),
		})
	}, [activeOtherCount])

	return null
}
