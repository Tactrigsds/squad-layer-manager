import * as LC from '@/models/layer-columns'
import * as Cli from '@/server/systems/cli.ts'
import fs from 'node:fs/promises'

export let EXTRA_COLS_CONFIG!: LC.ExtraColumnsConfig

export async function ensureSetup() {
	if (EXTRA_COLS_CONFIG) return
	let canAccess: boolean
	try {
		await fs.access(Cli.options.extraColumnsConfig)
		canAccess = true
	} catch {
		canAccess = false
	}
	if (!canAccess) {
		EXTRA_COLS_CONFIG = {
			columns: [],
		}
	} else {
		const raw = await fs.readFile(Cli.options.extraColumnsConfig, 'utf-8')
		EXTRA_COLS_CONFIG = LC.ExtraColumnsConfigSchema.parse(JSON.parse(raw))
	}
}
