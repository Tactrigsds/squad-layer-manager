import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as FB from '@/models/filter-builders'

import { type AppFixture, createAppFixture } from '../harness/app-fixture'
import { filter } from '../harness/arrange'
import { createOrpcClient, type TestOrpcClient } from '../harness/orpc-client'

// A filter that something still points at cannot be deleted, and filters cannot be made to reference each other in
// a loop. Both are server-side gates: the client disables the buttons, but nothing stops a caller from asking
// anyway, and a stored loop has no fixed point once the referenced filters are inlined at query time.

let app: AppFixture
let client: TestOrpcClient

beforeAll(async () => {
	app = await createAppFixture({
		filters: [
			filter('raas-only', 'RAAS Only', FB.and([FB.eq('Gamemode', 'RAAS')])),
			filter('raas-harju', 'RAAS on Harju', FB.and([FB.includedIn('raas-only'), FB.eq('Map', 'Harju')])),
			filter('pool-only', 'Pool Only', FB.and([FB.eq('Gamemode', 'AAS')])),
			filter('unused', 'Unused', FB.and([FB.eq('Gamemode', 'Invasion')])),
		],
		serverSettings: (settings) => {
			settings.queue.mainPool.poolFilter = { filterId: 'pool-only', mode: 'include' }
		},
	})
	client = await createOrpcClient(app)
}, 120_000)

afterAll(async () => {
	// deliberately not closing the client: see the teardown note in orpc-client.ts
	await app?.dispose()
})

describe('deleteFilter', () => {
	it('refuses a filter another filter applies', async () => {
		const res = await client.filters.deleteFilter('raas-only')
		expect(res.code).toBe('err:filter-in-use')
		expect(res.code === 'err:filter-in-use' && res.references).toContainEqual({ type: 'filter-entity', filterId: 'raas-harju' })
	})

	it('refuses a filter a pool is configured with', async () => {
		const res = await client.filters.deleteFilter('pool-only')
		expect(res.code).toBe('err:filter-in-use')
		expect(res.code === 'err:filter-in-use' && res.references).toContainEqual({
			type: 'pool-config',
			serverId: app.serverId,
			key: 'poolFilter',
			via: [],
		})
	})

	it('deletes a filter nothing references', async () => {
		expect((await client.filters.deleteFilter('unused')).code).toBe('ok')
	})
})

describe('cyclical references', () => {
	it('refuses an update that would close a loop', async () => {
		const res = await client.filters.updateFilter(['raas-only', { filter: FB.and([FB.includedIn('raas-harju')]) }])
		expect(res.code).toBe('err:cyclical-reference')
		expect(res.code === 'err:cyclical-reference' && res.cycle).toEqual(['raas-only', 'raas-harju', 'raas-only'])
	})

	it('allows an update that only deepens the chain', async () => {
		const res = await client.filters.updateFilter(['raas-only', { filter: FB.and([FB.includedIn('pool-only')]) }])
		expect(res.code).toBe('ok')
	})
})
