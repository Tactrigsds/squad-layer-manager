import React from 'react'

import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as USR_Msgs from '@/messages/users.messages'
import * as ConfigClient from '@/systems/config.client'
import { tr } from '@/systems/messages.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

// Renders nothing; while the current user has other clients (tabs / devices) holding an editing session, shows a
// persistent, dismissable toast offering to reset them (clear their activity, mark them away). The
// toast dismisses itself once no other client is editing -- e.g. after they're reset or disconnect.
export function ResetOtherSessionsManager() {
	const myClientId = Zus.useStore(ConfigClient.Store, (config) => config?.wsClientId)
	const loggedInUser = UsersClient.useLoggedInUser()
	const editingOtherCount = Zus.useStore(UPClient.Store, UPClient.Sel.editingOtherClientCount(loggedInUser?.discordId, myClientId))
	const discardsEdits = Zus.useStore(UPClient.Store, UPClient.Sel.stoppingOtherClientsDiscardsDrafts(loggedInUser?.discordId, myClientId))

	const toastIdRef = React.useRef<string | number | null>(null)

	React.useEffect(() => {
		if (editingOtherCount <= 0) {
			if (toastIdRef.current !== null) toast.dismiss(toastIdRef.current)
			toastIdRef.current = null
			return
		}
		const [message, opts] = tr.toast(USR_Msgs.otherSessionsEditing(editingOtherCount, discardsEdits))
		toastIdRef.current = toast.warning(message, {
			...opts,
			id: toastIdRef.current ?? undefined,
			// infinite duration -- it stays until dismissed or the other sessions stop editing
			duration: Infinity,
			action: {
				label: tr.text(USR_Msgs.stopOtherSessionsEditing()),
				onClick: () => UPClient.Actions.resetOtherClients(),
			},
		})
	}, [editingOtherCount, discardsEdits])

	return null
}
