import * as z from 'zod'

import { definePlugin } from 'slm/plugin'

// The packaged-plugin fixture: small, but it exercises everything a package has to reach through the
// host -- a config schema, its own table, a per-server hook and an rpc the client can call.
export default definePlugin({
	id: 'hello',
	name: 'Hello',
	version: '1.0.0',
	apiVersion: '^0.3',
	description: 'A packaged plugin used by the integration tests.',
	configSchema: z.object({
		greeting: z.string().prefault('hello').describe('What the plugin answers with'),
	}),
})
