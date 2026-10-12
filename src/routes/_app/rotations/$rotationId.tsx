import { createFileRoute } from '@tanstack/react-router'
import React from 'react'

import RotationEdit from '@/components/rotation-edit'
import * as Zus from '@/lib/zustand'
import * as APP_Msgs from '@/messages/app.messages'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as ROT from '@/models/rotations.models'
import { tr } from '@/systems/messages.client'
import * as RotationClient from '@/systems/rotation.client'
import * as UPClient from '@/systems/user-presence.client'

export const Route = createFileRoute('/_app/rotations/$rotationId')({
	component: RouteComponent,
	params: {
		parse: (params) => ({ rotationId: ROT.RotationIdSchema.parse(params.rotationId) }),
	},
	onLeave: () => {
		UPClient.Actions.dispatch({ code: 'navigated-away' })
	},
	head: () => ({
		meta: [{ title: tr.text(APP_Msgs.pageTitle(tr.text(ROT_Msgs.pageTitle()))) }],
	}),
})

function RouteComponent() {
	const { rotationId } = Route.useParams()
	const exists = Zus.useStore(RotationClient.Store, (s) => s.rotations.has(rotationId))

	// presence on the page is what the editing session and its item locks hang off
	React.useEffect(() => {
		if (exists) UPClient.Actions.ensureOnRotation(rotationId)
	}, [rotationId, exists])

	return <RotationEdit key={rotationId} rotationId={rotationId} />
}
