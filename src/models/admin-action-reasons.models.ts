import { renderTemplate } from '@/lib/templating'
import * as LP from '@/models/labeled-presets.models'
import type * as RBAC from '@/rbac.models'
import { z } from 'zod'

export const ADMIN_ACTION_TYPE = z.enum(['warn', 'kill', 'kick', 'remove-from-squad', 'disband-squad', 'demote-commander'])
export type AdminActionType = z.infer<typeof ADMIN_ACTION_TYPE>

// actions a reason can be configured as applicable to. warn is excluded: every reason is implicitly a warn reason.
export const EXECUTABLE_ADMIN_ACTION_TYPE = z.enum(['kill', 'kick', 'remove-from-squad', 'disband-squad', 'demote-commander'])
export type ExecutableAdminActionType = z.infer<typeof EXECUTABLE_ADMIN_ACTION_TYPE>

export type AdminActionDescriptor = {
	displayName: string
	targetKind: 'players' | 'player' | 'squad'
	permission: RBAC.PermissionType
	// native: the RCON command already delivers the reason to the player(s); follow-up-warn: SLM sends an in-game warn after the action
	reasonDelivery: 'native' | 'follow-up-warn'
}

export const ADMIN_ACTIONS: Record<AdminActionType, AdminActionDescriptor> = {
	'warn': { displayName: 'Warn', targetKind: 'players', permission: 'squad-server:warn-players', reasonDelivery: 'native' },
	'kill': { displayName: 'Kill', targetKind: 'players', permission: 'squad-server:manage-players', reasonDelivery: 'native' },
	// the AdminKick reason string carries the text
	'kick': { displayName: 'Kick', targetKind: 'player', permission: 'squad-server:timeout-players', reasonDelivery: 'native' },
	'remove-from-squad': {
		displayName: 'Remove from Squad',
		targetKind: 'players',
		permission: 'squad-server:manage-players',
		reasonDelivery: 'follow-up-warn',
	},
	'disband-squad': {
		displayName: 'Disband Squad',
		targetKind: 'squad',
		permission: 'squad-server:manage-players',
		reasonDelivery: 'follow-up-warn',
	},
	'demote-commander': {
		displayName: 'Demote Commander',
		targetKind: 'player',
		permission: 'squad-server:manage-players',
		reasonDelivery: 'follow-up-warn',
	},
}

export const AdminActionReasonSchema = LP.LabeledPresetSchema.extend({
	// warn text: every reason is a warn reason, so this is always required (`message` comes from LabeledPreset)
	message: z.string().trim().min(1).describe('Warn text: sent when this reason is used to warn a player'),
	// per-action text; a reason applies to an executable action iff it has text here
	actionTexts: z.partialRecord(EXECUTABLE_ADMIN_ACTION_TYPE, z.string().trim().min(1)).prefault({}).describe(
		'Per-action text. The reason is available for an action only if it has text for that action.',
	),
})
export type AdminActionReason = z.infer<typeof AdminActionReasonSchema>

export const AdminActionReasonsSchema = z.array(AdminActionReasonSchema)
	.superRefine(LP.addLabelAliasUniquenessIssues)
	.prefault([])

export function reasonsForAction(reasons: AdminActionReason[], action: AdminActionType): AdminActionReason[] {
	// every reason is implicitly a warn reason
	if (action === 'warn') return reasons
	return reasons.filter((r) => r.actionTexts[action] !== undefined)
}

// warns deliver the warn text; executable actions deliver their own text (falling back to the warn text)
export function reasonText(action: AdminActionType, reason: AdminActionReason): string {
	return action === 'warn' ? reason.message : (reason.actionTexts[action] ?? reason.message)
}

export type ResolveReasonRes =
	| { code: 'ok'; reason: AdminActionReason }
	| { code: 'err:reason-not-found'; msg: string }
	| { code: 'err:reason-not-applicable'; msg: string }

export function resolveReason(reasons: AdminActionReason[], action: AdminActionType, token: string): ResolveReasonRes {
	const reason = LP.findByLabelOrAlias(reasons, token)
	if (!reason) return { code: 'err:reason-not-found', msg: `Admin action reason "${token}" no longer exists` }
	if (action !== 'warn' && reason.actionTexts[action] === undefined) {
		return {
			code: 'err:reason-not-applicable',
			msg: `Admin action reason "${reason.label}" is not applicable to ${ADMIN_ACTIONS[action].displayName}`,
		}
	}
	return { code: 'ok', reason }
}

// a reason as applied to a concrete action: the unrendered template plus the variable values in effect at
// action time. Snapshotted into app events and the timeouts table so history renders exactly what was
// configured then, and so timeouts can re-render with the remaining duration substituted.
export const AppliedReasonSchema = z.object({
	// absent for custom (free-text) reasons
	label: z.string().optional(),
	template: z.string(),
	vars: z.record(z.string(), z.string()),
})
export type AppliedReason = z.infer<typeof AppliedReasonSchema>

export function applyReason(action: AdminActionType, reason: AdminActionReason, vars: Record<string, string>): AppliedReason {
	return { label: reason.label, template: reasonText(action, reason), vars }
}

export function applyCustomReason(text: string, vars: Record<string, string>): AppliedReason {
	return { template: text, vars }
}

// renders an applied reason (mustache templating over the snapshotted vars plus {{label}}), with optional
// per-render extras (e.g. the remaining timeout duration) and the `@Squad<id>` tag when messaging a squad
export function renderAppliedReason(
	applied: AppliedReason,
	opts?: { squadTag?: string; extraVars?: Record<string, string> },
): string {
	const rendered = renderTemplate(applied.template, { ...applied.vars, label: applied.label ?? '', ...opts?.extraVars })
	return opts?.squadTag ? `${opts.squadTag} ${rendered}` : rendered
}

// convenience for previews and one-shot renders: apply + render in one step
export function formatAppliedReason(
	action: AdminActionType,
	reason: AdminActionReason,
	opts?: { squadTag?: string; vars?: Record<string, string> },
): string {
	return renderAppliedReason(applyReason(action, reason, opts?.vars ?? {}), { squadTag: opts?.squadTag })
}
