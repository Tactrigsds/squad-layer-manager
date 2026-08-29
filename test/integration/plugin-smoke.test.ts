import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { createOrpcClient, firstYield, type TestOrpcClient } from '../harness/orpc-client'

// The contract test a plugin repo runs against this build of SLM: pack the plugin, point this at the output,
// and it boots a real app with the package installed and turns it on.
//
//   SLM_SMOKE_PLUGIN_DIRS=/path/to/seed-roller/dist pnpm test:integration test/integration/plugin-smoke.test.ts
//
// Typechecking a plugin proves its source compiles against `slm/*`. It does not prove the packed bundle runs:
// the entries resolve through the host's registries at load time, so an import that is only in the client
// registry, or an apiVersion this build does not satisfy, fails here and nowhere earlier. That gap is exactly
// what the dev loop bypasses, which is why a plugin's own CI needs this before it deploys anything.
//
// Skipped, and therefore free, when the variable is unset -- which is every run of SLM's own suite.

const dirs = (process.env.SLM_SMOKE_PLUGIN_DIRS ?? '')
	.split(',')
	.map((d) => d.trim())
	.filter(Boolean)

describe.skipIf(dirs.length === 0)('a packed plugin installs and activates', () => {
	let app: AppFixture
	let client: TestOrpcClient

	beforeAll(async () => {
		for (const dir of dirs) {
			if (!fs.existsSync(path.join(dir, 'plugin.json'))) {
				throw new Error(`${dir} is not a packed plugin: no plugin.json. Run \`pnpm plugin:pack <source>\` first.`)
			}
		}
		app = await createAppFixture({ installPlugins: dirs })
		client = await createOrpcClient(app)
	}, 180_000)

	afterAll(async () => {
		await app?.dispose()
	})

	async function statusOf(pluginId: string) {
		const next = await firstYield((signal) => client.plugins.watchPlugins(undefined, { signal }), { label: 'the plugin list stream' })
		return (next.plugins as { id: string; status: string; error: string | null }[]).find((p) => p.id === pluginId)
	}

	for (const dir of dirs) {
		const { id, name } = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as { id: string; name: string }

		it(`${name} (${id}) activates`, async () => {
			// installed but off, as any newly installed package is: enabling is what runs its server entry
			expect(await statusOf(id)).toMatchObject({ status: 'inactive' })

			const res = await client.plugins.setEnabled({ pluginId: id, enabled: true })
			expect(res).toMatchObject({ code: 'ok' })

			const status = await statusOf(id)
			// the error is asserted before the status so a failure says why rather than just "not active"
			expect(status?.error).toBeNull()
			expect(status?.status).toBe('active')
		})
	}
})
