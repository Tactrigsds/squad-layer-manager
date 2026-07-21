import type { MigrationDriver } from '@/server/migrate'

// Collapses the main-pool/generation-pool repeat rule split into one list with a per-rule flag.
//
// Old shape (servers.settings.json.queue):
//   mainPool.repeatRules: Array<{ label, field, within, targetValues?, warn? }>
//   generationPool: { repeatRules: RepeatRule[], applyMainPoolRepeatRules: boolean }
//
// New shape:
//   mainPool.repeatRules[]: gains constrainGeneration: boolean; generationPool is deleted.
//
// Every migrated rule gets constrainGeneration: true. This deliberately turns enforcement ON for servers where
// applyMainPoolRepeatRules was false: that flag silently defaulted off in 7930e20d (2026-05-31), which left
// configured repeat rules warning about repeats without ever preventing them during autogeneration.
// generationPool.repeatRules (generation-only rules, no warn) fold into the same list with warn unset; a label
// collision with a main-pool rule gets a " (generation)" suffix to satisfy the unique-label constraint.
//
// `settings` is stored superjson-wrapped ({ json, meta }); the touched values are plain objects/arrays so `meta`
// never references them. Idempotent: servers without a `generationPool` key are left alone.
export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, settings FROM servers`).all() as { id: string; settings: string | null }[]
	for (const row of rows) {
		if (!row.settings) continue
		const wrapper = JSON.parse(row.settings) as { json?: any; meta?: any }
		const queue = wrapper?.json?.queue
		if (!queue || !('generationPool' in queue)) continue
		const mainPool = queue.mainPool ?? (queue.mainPool = {})

		const rules: any[] = (Array.isArray(mainPool.repeatRules) ? mainPool.repeatRules : [])
			.filter((rule: any) => rule && typeof rule === 'object')
		for (const rule of rules) rule.constrainGeneration = true

		const genRules: any[] = Array.isArray(queue.generationPool?.repeatRules) ? queue.generationPool.repeatRules : []
		const labels = new Set(rules.map((rule: any) => rule.label))
		for (const rule of genRules) {
			if (!rule || typeof rule !== 'object') continue
			let label = rule.label
			while (labels.has(label)) label = `${label} (generation)`
			labels.add(label)
			rules.push({ ...rule, label, constrainGeneration: true })
		}

		mainPool.repeatRules = rules
		delete queue.generationPool

		db.prepare(`UPDATE servers SET settings = ? WHERE id = ?`).run(JSON.stringify(wrapper), row.id)
	}
}
