import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppFixture, createAppFixture } from '../harness/app-fixture'

// A failing test is much easier to read as a trace than as a log tail, so the app under test can
// export its telemetry labelled with the test that produced it (SLM_TEST_OTEL=1, see the README).
// This is what keeps that labelling honest.
//
// No app code is involved: the otel sdk merges its detected resource (which includes the env detector,
// reading OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME) *after* the resource the app passes it, so the
// environment wins -- service.name included. That's why the harness only has to set an env var.

let app: AppFixture
let sink: http.Server
const received: string[] = []

beforeAll(async () => {
	// stands in for the collector. OTLP/protobuf leaves attribute keys and string values as plain
	// UTF-8, so the labels can be read off the wire without decoding protobuf.
	sink = http.createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on('data', (c) => chunks.push(c as Buffer))
		req.on('end', () => {
			received.push(Buffer.concat(chunks).toString('latin1'))
			res.writeHead(200, { 'content-type': 'application/x-protobuf' })
			res.end()
		})
	})
	await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', () => resolve()))
	const port = (sink.address() as AddressInfo).port

	app = await createAppFixture({
		label: 'telemetry > carries the labels',
		otel: { endpoint: `http://127.0.0.1:${port}` },
	})
}, 120_000)

afterAll(async () => {
	await app?.dispose()
	sink?.close()
})

describe('telemetry from the app under test', () => {
	it('is labelled with the test that produced it', async () => {
		// something worth tracing: a poll of the emulated server
		await app.emu.expectCommand(/^ListPlayers$/, { timeoutMs: 20_000 })

		await app.waitFor(() => received.length > 0, { label: 'an export from the app', timeoutMs: 30_000 })
		const body = received.join('\n')

		// the app names itself squad-layer-manager; the env overrides that, which is how a test's
		// telemetry becomes findable as that test's rather than mixed in with a deployment's
		expect(body).toContain('slm-test')
		expect(body).toContain('telemetry > carries the labels')
		expect(body).toContain(app.otelLabels['slm.test.run_id'])
		expect(body).toContain(app.serverId)
	})
})
