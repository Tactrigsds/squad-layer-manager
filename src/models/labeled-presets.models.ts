import { BasicStrNoWhitespace } from '@/lib/zod'
import StringComparison from 'string-comparison'
import { z } from 'zod'

// shared shape for admin-configurable preset messages addressable by label or alias
// (admin action reasons, broadcasts)

export const LabeledPresetSchema = z.object({
	label: z.string().trim().min(1).max(60).describe('Short name shown in menus and the audit log'),
	message: z.string().trim().min(1),
	aliases: z.array(BasicStrNoWhitespace).prefault([]).describe('Aliases usable to select this preset in in-game chat commands'),
})
export type LabeledPreset = z.infer<typeof LabeledPresetSchema>

// labels unique, aliases unique across all presets, and aliases must not collide with labels, since both
// address a preset in chat commands. all case-insensitive.
export function addLabelAliasUniquenessIssues(
	presets: Pick<LabeledPreset, 'label' | 'aliases'>[],
	ctx: z.core.$RefinementCtx,
): void {
	const seenLabels = new Map<string, number>()
	const seenAliases = new Map<string, number>()
	presets.forEach((preset, i) => {
		const labelKey = preset.label.toLowerCase()
		if (seenLabels.has(labelKey)) {
			ctx.addIssue({ code: 'custom', message: `Duplicate label "${preset.label}"`, path: [i, 'label'] })
		} else {
			seenLabels.set(labelKey, i)
		}
		preset.aliases.forEach((alias, j) => {
			const aliasKey = alias.toLowerCase()
			if (seenAliases.has(aliasKey)) {
				ctx.addIssue({ code: 'custom', message: `Duplicate alias "${alias}"`, path: [i, 'aliases', j] })
			} else {
				seenAliases.set(aliasKey, i)
			}
		})
	})
	presets.forEach((preset, i) => {
		preset.aliases.forEach((alias, j) => {
			if (seenLabels.has(alias.toLowerCase())) {
				ctx.addIssue({ code: 'custom', message: `Alias "${alias}" collides with a preset label`, path: [i, 'aliases', j] })
			}
		})
	})
}

export function findByLabelOrAlias<T extends { label: string; aliases: string[] }>(presets: T[], token: string): T | undefined {
	const key = token.toLowerCase()
	return presets.find((p) => p.label.toLowerCase() === key || p.aliases.some((a) => a.toLowerCase() === key))
}

export function labelAliasStrings(presets: { label: string; aliases: string[] }[]): string[] {
	return presets.flatMap((p) => [p.label, ...p.aliases])
}

// best match for "Did you mean ...?" feedback. Levenshtein rather than the dice coefficient parseCommand
// uses: aliases are often 2-3 chars, where bigram overlap is degenerate
export function didYouMean(input: string, candidates: string[]): string | undefined {
	if (candidates.length === 0) return undefined
	const sorted = StringComparison.levenshtein.sortMatch(input.toLowerCase(), candidates)
	const best = sorted[sorted.length - 1]
	if (!best || best.rating <= 0) return undefined
	return best.member
}

export const BroadcastPresetSchema = LabeledPresetSchema.extend({
	message: z.string().trim().min(1).describe('Broadcast text, sent verbatim via AdminBroadcast'),
})
export type BroadcastPreset = z.infer<typeof BroadcastPresetSchema>

export const BroadcastPresetsSchema = z.array(BroadcastPresetSchema)
	.superRefine(addLabelAliasUniquenessIssues)
	.prefault([])
