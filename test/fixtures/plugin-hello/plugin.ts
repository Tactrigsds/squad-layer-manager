import * as z from 'zod'

import { definePlugin } from 'slm/plugin'
import { Fields } from 'slm/plugin/fields'

// The packaged-plugin fixture: small, but it exercises everything a package has to reach through the
// host -- a config schema, its own table, a per-server hook and an rpc the client can call.
export default definePlugin({
	id: 'hello',
	name: 'Hello',
	version: '1.0.0',
	apiVersion: '^0.4',
	description: 'A packaged plugin used by the integration tests.',
	configSchema: z.object({
		greeting: z.string().prefault('hello').describe('What the plugin answers with'),
		// a filter this plugin's config names, so the host counts it as a reference and refuses its delete
		pool: Fields.filterId().prefault('').describe('A filter the plugin holds a reference to'),
	}),
})
