/**
 * Repeat rulesets: named lists of repeat rules, kept in the global settings. Every server and rotation points at one
 * by id, so one ruleset can serve several servers and rotations.
 */
export {
	DEFAULT_RULES,
	MAX_NAME_LENGTH,
	RepeatRuleConfigSchema,
	RulesetIdSchema,
	RulesetSchema,
	rulesFor,
} from '@/models/repeat-rulesets.models'
export type { RepeatRuleConfig, Ruleset, RulesetId } from '@/models/repeat-rulesets.models'
