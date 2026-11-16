import { createFileRoute } from '@tanstack/react-router'
import React from 'react'

import { RotationNew } from '@/components/rotation-edit'
import { useFrameLifecycle, useFrameTeardownOnUnmount } from '@/frames/frame-manager'
import * as RotationEditorFrame from '@/frames/rotation-editor.frame'
import * as APP_Msgs from '@/messages/app.messages'
import * as ROT_Msgs from '@/messages/rotations.messages'
import { tr } from '@/systems/messages.client'
import * as UPClient from '@/systems/user-presence.client'

const NEW_ROTATION_INPUT = RotationEditorFrame.createInput(null)

export const Route = createFileRoute('/_app/rotations/new')({
	component: RouteComponent,
	onLeave: () => {
		UPClient.Actions.dispatch({ code: 'navigated-away' })
	},
	head: () => ({
		meta: [{ title: tr.text(APP_Msgs.pageTitle(tr.text(ROT_Msgs.newRotation()))) }],
	}),
})

function RouteComponent() {
	const listHost = useFrameLifecycle(RotationEditorFrame.frame, { input: NEW_ROTATION_INPUT })
	// a new rotation that is left is gone, so the next visit starts an empty one
	useFrameTeardownOnUnmount(listHost)

	// the add-layers and vote dialogs open from the client's presence on this page
	React.useEffect(() => {
		UPClient.Actions.ensureOnNewRotation()
	}, [])

	return <RotationNew listHost={listHost} />
}
