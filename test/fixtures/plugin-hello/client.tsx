import * as React from 'react'

import * as Zus from 'slm/lib/zustand'
import { definePluginClient } from 'slm/plugin/client'
import * as Rpc from 'slm/plugin/rpc.client'
import * as Slots from 'slm/plugin/slots'

import manifest from './plugin.ts'

// exercises the browser half of the shim: react, zustand and slm/* all come from the host page
export default definePluginClient(manifest, (ctx) => {
	const greetings$ = Rpc.queryStore<[string], { text: string }[]>(ctx, 'greetings', (serverId: string) => ({
		serverId,
		input: { serverId },
	}))

	Slots.register(ctx, 'server-dashboard:alerts', (props) => {
		const rows = Zus.useStore(greetings$(props.serverId), (r) => r ?? [])
		if (rows.length === 0) return null
		return <p data-testid="hello-plugin-slot">{rows[0].text}</p>
	})
})
