#!/usr/bin/env node
// Talks to a running SLM over its control socket (see src/systems/control-socket.server.ts). Standalone and
// dependency-free on purpose: the production image ships neither tsx nor src/, so anything reached with
// `docker exec` has to run on plain node.
//
//   docker exec slm-app-prod pnpm plugins:reload [--expect <plugin-id>...]
//
// --expect fails the command when the named plugin did not come back up, which is what lets a deploy
// notice that the package it just copied in is broken.

import * as net from 'node:net'
import * as path from 'node:path'

const SOCKET = process.env.CONTROL_SOCKET || path.join(process.cwd(), 'data', 'control.sock')

const [command, ...rest] = process.argv.slice(2)
if (!command) {
	console.error('usage: slm-control <command> [--expect <plugin-id>...]')
	process.exit(2)
}
const expect = rest.flatMap((arg, i) => (rest[i - 1] === '--expect' ? [arg] : []))

function request(payload) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(SOCKET)
		let buffer = ''
		socket.setEncoding('utf8')
		socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
		socket.on('data', (chunk) => (buffer += chunk))
		socket.on('error', reject)
		socket.on('close', () => {
			if (!buffer.trim()) return reject(new Error('the app closed the connection without answering'))
			try {
				resolve(JSON.parse(buffer))
			} catch {
				reject(new Error(`unparseable reply: ${buffer.slice(0, 200)}`))
			}
		})
	})
}

let res
try {
	res = await request({ command })
} catch (err) {
	console.error(`could not reach SLM on ${SOCKET}: ${err.message}`)
	console.error('is the app running, and is this being run inside its container?')
	process.exit(1)
}

if (res.code !== 'ok') {
	console.error(`${command} failed: ${res.code}${res.message ? ` (${res.message})` : ''}`)
	process.exit(1)
}

for (const plugin of res.plugins ?? []) {
	console.log(`${plugin.id}: ${plugin.status}${plugin.error ? ` (${plugin.error})` : ''}`)
}

// A plugin that is installed but switched off is not a failure: enabling is an admin's decision, and the
// first deploy of a new plugin always lands on one nobody has turned on yet.
const failed = expect.filter((id) => {
	const plugin = (res.plugins ?? []).find((p) => p.id === id)
	if (!plugin) return true
	return plugin.status !== 'active' && plugin.enabled !== false
})
if (failed.length > 0) {
	console.error(`not running after reload: ${failed.join(', ')}`)
	process.exit(1)
}
