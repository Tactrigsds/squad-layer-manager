import { Hand } from 'lucide-react'
import * as React from 'react'

import { Badge } from 'slm/components/ui'
import * as Zus from 'slm/lib/zustand'
import { definePluginClient } from 'slm/plugin/client'
import * as Rpc from 'slm/plugin/rpc.client'
import * as Slots from 'slm/plugin/slots'

import manifest from './plugin.ts'
import type { router } from './server.ts'

// exercises the browser half of the shim: react, zustand and slm/* all come from the host page. The
// utility class is one the app does not use, so it is only styled if the packed stylesheet carried it.
// lucide-react is a dependency the bundle carries, and it names its ESM build with `module` rather than `exports`.
export default definePluginClient(manifest, (ctx) => {
	// inferred from the server router: no annotations
	const streams = Rpc.stores<typeof router>(ctx)

	Slots.register(ctx, 'server-dashboard:alerts', (props) => {
		const rows = Zus.useStore(streams.greetings(props.serverId, { serverId: props.serverId }), (r) => r ?? [])
		if (rows.length === 0) return null
		return (
			<div data-testid="hello-plugin-slot" className="italic">
				<Hand />
				<Badge variant="outline">{rows[0].text}</Badge>
			</div>
		)
	})
})
