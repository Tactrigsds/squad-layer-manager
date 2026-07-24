import { BasicStrNoWhitespace } from '@/lib/zod'
import StringComparison from 'string-comparison'
import { z } from 'zod'

// shared shape for admin-configurable presets addressable from in-game chat (admin action reasons).
// The label names the preset in menus and the audit log; the keywords are what chat matches against, and are
// deliberately the only thing it matches: a preset arg is only recognized as one token, so a label with whitespace
// would silently be unreachable.

export const LabeledPresetSchema = z.object({
	label: z.string().trim().min(1).max(60).describe('Short name shown in menus and the audit log'),
	keywords: z.array(BasicStrNoWhitespace).min(1).describe(
		'What admins type to select this preset in in-game chat commands. At least one is required, and none may contain whitespace.',
	),
})
export type LabeledPreset = z.infer<typeof LabeledPresetSchema>

// labels unique and keywords unique across all presets, all case-insensitive. A keyword equal to its own preset's
// label is unremarkable (labels aren't matched in chat), so only keyword-vs-keyword collisions are ambiguous.
export function addLabelKeywordUniquenessIssues(
	presets: Pick<LabeledPreset, 'label' | 'keywords'>[],
	ctx: z.core.$RefinementCtx,
): void {
	const seenLabels = new Set<string>()
	const seenKeywords = new Set<string>()
	presets.forEach((preset, i) => {
		const labelKey = preset.label.toLowerCase()
		if (seenLabels.has(labelKey)) {
			ctx.addIssue({ code: 'custom', message: `Duplicate label "${preset.label}"`, path: [i, 'label'] })
		} else {
			seenLabels.add(labelKey)
		}
		preset.keywords.forEach((keyword, j) => {
			const keywordKey = keyword.toLowerCase()
			if (seenKeywords.has(keywordKey)) {
				ctx.addIssue({ code: 'custom', message: `Duplicate keyword "${keyword}"`, path: [i, 'keywords', j] })
			} else {
				seenKeywords.add(keywordKey)
			}
		})
	})
}

export function findByKeyword<T extends { keywords: string[] }>(presets: T[], token: string): T | undefined {
	const key = token.toLowerCase()
	return presets.find((p) => p.keywords.some((k) => k.toLowerCase() === key))
}

export function keywordStrings(presets: { keywords: string[] }[]): string[] {
	return presets.flatMap((p) => p.keywords)
}

// the keyword a label seeds when the operator hasn't typed one: lowercased, with runs of anything that isn't a
// letter/digit collapsed to a dash, so it is always a valid (whitespace-free) keyword.
export function keywordFromLabel(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// how a preset reads wherever its typeable form has to be advertised (in-game help, error hints): its label, plus
// the keywords that aren't already the label itself, since matching is case-insensitive and "Toxicity (toxicity)"
// is only noise.
export function describePreset(preset: { label: string; keywords: string[] }): string {
	const distinct = preset.keywords.filter((k) => k.toLowerCase() !== preset.label.toLowerCase())
	return distinct.length === 0 ? preset.label : `${preset.label} (${distinct.join(', ')})`
}

// best match for "Did you mean ...?" feedback. Levenshtein rather than the dice coefficient parseCommand
// uses: keywords are often 2-3 chars, where bigram overlap is degenerate
export function didYouMean(input: string, candidates: string[]): string | undefined {
	if (candidates.length === 0) return undefined
	const sorted = StringComparison.levenshtein.sortMatch(input.toLowerCase(), candidates)
	const best = sorted[sorted.length - 1]
	if (!best || best.rating <= 0) return undefined
	return best.member
}
