import * as React from 'react'

import * as Zus from 'slm/lib/zustand'
import { definePluginClient } from 'slm/plugin/client'
import * as Rpc from 'slm/plugin/rpc.client'
import * as Slots from 'slm/plugin/slots'

import manifest from './plugin.ts'
import type { router } from './server.ts'

// exercises the browser half of the shim: react, zustand and slm/* all come from the host page
export default definePluginClient(manifest, (ctx) => {
	// inferred from the server router: no annotations
	const streams = Rpc.stores<typeof router>(ctx)

	Slots.register(ctx, 'server-dashboard:alerts', (props) => {
		const rows = Zus.useStore(streams.greetings(props.serverId, { serverId: props.serverId }), (r) => r ?? [])
		if (rows.length === 0) return null
		return <p data-testid="hello-plugin-slot">{rows[0].text}</p>
	})
})
