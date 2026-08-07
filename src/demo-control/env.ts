import * as dotenv from 'dotenv'
import path from 'node:path'
import { z } from 'zod'

import * as ZodUtils from '@/lib/zod-utils'

// The control plane's own configuration. Deliberately separate from src/server/env.ts: that schema describes one
// SLM instance, and this process is not one. It spawns them, and the variables it hands each child are built here
// rather than read from its own environment.

const EnvSchema = z.object({
	DEMO_CONTROL_PORT: ZodUtils.ParsedIntSchema.default(8080),
	DEMO_CONTROL_HOST: z.string().min(1).default('0.0.0.0'),

	// wildcard-resolving domain instances are reached under: <prefix>g-<guildId>.<domain>, <prefix>t-<slug>.<domain>
	DEMO_BASE_DOMAIN: z.string().min(1),
	// where the portal, the login broker and the fleet page answer, as a browser reaches them. Everything about
	// how the fleet is addressed from outside is derived from this: the scheme and port an instance url is built
	// with, and which host counts as the apex. Defaults to https on DEMO_BASE_DOMAIN itself.
	DEMO_APEX_ORIGIN: ZodUtils.NormedUrl.optional(),
	// prepended to every instance's subdomain label. Empty means instances sit directly under DEMO_BASE_DOMAIN,
	// which wants a wildcard record and certificate of their own. A prefix lets them share an existing one
	// instead: DNS and TLS wildcards both match a single label, so `slm-demo-g-123.example.com` is covered by an
	// existing `*.example.com` where `g-123.demo.example.com` is not.
	DEMO_HOST_PREFIX: z
		.string()
		.regex(/^[a-z0-9-]*$/, { error: 'must be lowercase letters, digits and dashes' })
		.default(''),

	DEMO_DATA_DIR: z.string().min(1).default(path.join('data', 'demo-fleet')),
	// what an instance's `node` is pointed at. The control plane and its children are the same bundle.
	DEMO_INSTANCE_ENTRY: z.string().min(1).default('dist-server/main-instrumented.js'),
	// The memory flags are measured: stock 601MB RSS per instance, 465MB with these, which is the difference
	// between a 52GB fleet and a 39GB one. See dev_docs/demo_fleet.md. register-otel is deliberately absent, since
	// instances run with OTEL_ENABLED=false.
	DEMO_INSTANCE_NODE_OPTIONS: z.string().default('--max-semi-space-size=16 --max-old-space-size=1024 --import ./register-source-maps.mjs'),
	// slot n listens on this + n
	DEMO_INSTANCE_PORT_BASE: ZodUtils.ParsedIntSchema.default(3100),

	// discord verifies an app at 100 guilds; staying under it is the difference between the fleet growing and the
	// fleet stopping
	DEMO_MAX_GUILD_INSTANCES: ZodUtils.ParsedIntSchema.pipe(z.number().min(1).max(90)).default(90),
	DEMO_MAX_EPHEMERAL_INSTANCES: ZodUtils.ParsedIntSchema.pipe(z.number().min(1)).default(8),

	DEMO_GUILD_IDLE_TIMEOUT: ZodUtils.HumanTime.prefault('72h'),
	DEMO_EPHEMERAL_IDLE_TIMEOUT: ZodUtils.HumanTime.prefault('45m'),
	DEMO_EPHEMERAL_MAX_LIFETIME: ZodUtils.HumanTime.prefault('4h'),
	DEMO_REAP_INTERVAL: ZodUtils.HumanTime.prefault('1m'),
	// how many ephemeral instances one address may mint per hour
	DEMO_EPHEMERAL_PER_IP_HOURLY: ZodUtils.ParsedIntSchema.pipe(z.number().min(1)).default(3),

	// the fleet's own discord application: one gateway session, one oauth redirect uri, one rate limit budget
	DEMO_DISCORD_CLIENT_ID: z.string().min(1).optional(),
	DEMO_DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
	DEMO_DISCORD_BOT_TOKEN: z.string().min(1).optional(),

	// gates /fleet on the apex. Unset means the page does not exist: it names running instances, and an
	// ephemeral instance's subdomain is the only thing keeping strangers out of it.
	DEMO_FLEET_TOKEN: z.string().min(16).optional(),

	// The header the fronting proxy is trusted to have set to the real client address, for the per-address mint
	// limit. Unset uses the socket address, which is the only value nobody can lie about; name a header only
	// where something in front of the fleet *overwrites* it, since one that is merely appended to (as
	// X-Forwarded-For is) can be prefixed with anything by the client. Behind Cloudflare that is
	// `cf-connecting-ip`; behind a lone nginx or Caddy, `x-real-ip`.
	DEMO_CLIENT_IP_HEADER: z.string().min(1).toLowerCase().optional(),

	DEMO_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

export type Env = z.infer<typeof EnvSchema> & {
	apexOrigin: string
	// the host the portal answers on, which is not always DEMO_BASE_DOMAIN: a prefixed fleet puts instances under
	// a domain it does not own the apex of
	apexHost: string
	// scheme and port an instance url is built with, taken from the apex rather than assumed. A laptop on plain
	// http and a deployment behind TLS termination differ here, and a login redirect built with the wrong one
	// lands on a url nothing is listening on.
	instanceScheme: string
	instancePortSuffix: string
	dataDir: string
	// the guild flow needs an application to be a bot of; without one the fleet still serves the ephemeral portal
	guildFlowEnabled: boolean
}

let env: Env | undefined

// Deliberately re-parses rather than memoizing. It is called once by main, and a setup that reads process.env
// afresh is one a test can drive twice with different values.
export function setup(): Env {
	dotenv.config({ quiet: true })
	const parsed = EnvSchema.parse(process.env)

	const discordCredentials = [parsed.DEMO_DISCORD_CLIENT_ID, parsed.DEMO_DISCORD_CLIENT_SECRET, parsed.DEMO_DISCORD_BOT_TOKEN]
	if (discordCredentials.some(Boolean) && !discordCredentials.every(Boolean)) {
		throw new Error(
			'The guild flow needs all three of DEMO_DISCORD_CLIENT_ID, DEMO_DISCORD_CLIENT_SECRET and DEMO_DISCORD_BOT_TOKEN, or none of them.',
		)
	}

	const apexOrigin = parsed.DEMO_APEX_ORIGIN ?? `https://${parsed.DEMO_BASE_DOMAIN}`
	const apex = new URL(apexOrigin)

	env = {
		...parsed,
		apexOrigin,
		apexHost: apex.hostname,
		instanceScheme: apex.protocol.replace(/:$/, ''),
		instancePortSuffix: apex.port ? `:${apex.port}` : '',
		dataDir: path.resolve(parsed.DEMO_DATA_DIR),
		guildFlowEnabled: discordCredentials.every(Boolean),
	}
	return env
}

export function get(): Env {
	if (!env) throw new Error('demo-control env read before setup')
	return env
}
