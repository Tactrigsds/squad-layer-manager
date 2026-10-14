// Merging one Tailwind-compiled rule list into another, so that two separately compiled sheets cascade as if
// Tailwind had compiled them together.
//
// Tailwind orders utilities so that a later rule wins a conflict: `flex-col` comes before every variant of
// `flex-row`. Two sheets compiled apart are each ordered, but the second one loaded comes after the first in the
// cascade as a whole, so a base utility both sheets use overrides the first sheet's variants of it.
//
// Both lists are sorted by the same comparator, so a rule present in both is an anchor. A rule only the source has is
// inserted right after the rule preceding it in the source. Every element's classes are compiled into one of the two
// sheets, so the merge keeps the relative order of every rule that can match a given element.

export type RuleParent = CSSStyleSheet | CSSGroupingRule

function ruleKey(rule: CSSRule): string | null {
	if (rule instanceof CSSStyleRule) return `s${rule.selectorText}`
	if (rule instanceof CSSConditionRule) return `${rule.constructor.name}${rule.conditionText}`
	if (rule instanceof CSSLayerBlockRule) return `l${rule.name}`
	if (rule instanceof CSSKeyframesRule) return `k${rule.name}`
	if (rule instanceof CSSPropertyRule) return `p${rule.name}`
	return null
}

// Inserts into `into` each rule of `from` it lacks, recursing into grouping rules present in both. Returns the
// inserted rules, for `remove`.
export function merge(into: RuleParent, from: RuleParent, inserted: CSSRule[] = []): CSSRule[] {
	const keys = Array.from(into.cssRules, ruleKey)
	const present = new Set(keys)
	let cursor = 0
	for (const rule of from.cssRules) {
		const key = ruleKey(rule)
		if (key === null || !present.has(key)) {
			into.insertRule(rule.cssText, cursor)
			inserted.push(into.cssRules[cursor])
			keys.splice(cursor, 0, key)
			cursor++
			continue
		}
		const at = keys.indexOf(key, cursor)
		// present but behind the cursor: the two sheets disagree on order, and `into` already has the rule
		if (at === -1) continue
		const target = into.cssRules[at]
		if (rule instanceof CSSGroupingRule && target instanceof CSSGroupingRule) merge(target, rule, inserted)
		cursor = at + 1
	}
	return inserted
}

// Removes rules `merge` inserted. A rule whose parent has since been dropped is skipped.
export function remove(rules: CSSRule[]) {
	for (const rule of rules) {
		const parent = (rule.parentRule ?? rule.parentStyleSheet) as RuleParent | null
		if (!parent) continue
		const at = Array.prototype.indexOf.call(parent.cssRules, rule)
		if (at !== -1) parent.deleteRule(at)
	}
}
