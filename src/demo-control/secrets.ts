import * as Crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import * as DemoToken from '@/lib/demo-login-token'

import * as ControlEnv from './env.ts'
import type * as Registry from './registry.ts'

// Secrets the control plane generates once and must then keep: regenerating the broker keypair invalidates every
// session in the fleet, and regenerating an instance's settings key makes its stored connection details
// unreadable. Both live beside the data they belong to, on the /data volume.

const BrokerKeysSchema = z.object({ privateKey: z.string().min(1), publicKey: z.string().min(1) })

let brokerKeys: DemoToken.Keypair | undefined

export function setupBrokerKeys(): DemoToken.Keypair {
	if (brokerKeys) return brokerKeys
	const file = path.join(ControlEnv.get().dataDir, 'broker-keys.json')
	try {
		brokerKeys = BrokerKeysSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
	} catch {
		brokerKeys = DemoToken.generateKeypair()
		fs.writeFileSync(file, JSON.stringify(brokerKeys), { mode: 0o600 })
	}
	return brokerKeys
}

export function getBrokerKeys(): DemoToken.Keypair {
	if (!brokerKeys) throw new Error('broker keys read before setup')
	return brokerKeys
}

const InstanceSecretsSchema = z.object({
	// what the instance authenticates to the guild-scoped discord api with; it identifies the instance, so the
	// api can scope every call to the one guild that instance is for
	proxySecret: z.string().min(1),
	settingsEncryptionKey: z.string().min(1),
})
export type InstanceSecrets = z.infer<typeof InstanceSecretsSchema>

const byProxySecret = new Map<string, string>()
const byInstance = new Map<string, InstanceSecrets>()

export function forInstance(instance: Registry.Instance, dir: string): InstanceSecrets {
	const cached = byInstance.get(instance.id)
	if (cached) return cached

	const file = path.join(dir, 'secrets.json')
	let secrets: InstanceSecrets
	try {
		secrets = InstanceSecretsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
	} catch {
		secrets = {
			proxySecret: Crypto.randomBytes(32).toString('base64url'),
			settingsEncryptionKey: Crypto.randomBytes(32).toString('base64'),
		}
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 })
	}
	byInstance.set(instance.id, secrets)
	byProxySecret.set(secrets.proxySecret, instance.id)
	return secrets
}

// Which instance a guild-scoped discord api call is coming from. Only a running instance can be calling, and
// spawning one goes through forInstance, so anything that reaches the api is in here.
export function instanceIdForProxySecret(secret: string): string | undefined {
	return byProxySecret.get(secret)
}

export function forgetInstance(instanceId: string) {
	const secrets = byInstance.get(instanceId)
	if (!secrets) return
	byInstance.delete(instanceId)
	byProxySecret.delete(secrets.proxySecret)
}
