import type * as SB from '@/models/sandbox.models'

// The control window's view of a sandbox. Shared rather than inferred from the router so the frame can name it
// without importing server code.
export type SandboxPlayer = {
	name: string
	eosId: string
	steamId: string
	teamId: number | null
	squadId: number | null
	groups: string[]
	isAdmin: boolean
}

export type SandboxGroup = { name: string; permissions: string[] }

export type SandboxState = {
	code: 'ok'
	groups: SandboxGroup[]
	adminsCfg: string
	nextDefaultName: string
	players: SandboxPlayer[]
}

export type { SB }
