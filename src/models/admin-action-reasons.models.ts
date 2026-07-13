import { renderTemplate } from '@/lib/templating'
import * as LP from '@/models/labeled-presets.models'
import type * as RBAC from '@/rbac.models'
import { z } from 'zod'

// a kick removes the player from the server; a timeout additionally bars them from rejoining any SLM server
// until it expires. They're separate actions with separate texts, permissions and commands.
export const ADMIN_ACTION_TYPE = z.enum([
	'warn',
	'kill',
	'kick',
	'timeout',
	'remove-from-squad',
	'disband-squad',
	'demote-commander',
])
export type AdminActionType = z.infer<typeof ADMIN_ACTION_TYPE>

// actions whose reason requirement is configurable. warn is excluded: a warn is nothing but its reason, so one
// is always required.
export const REQUIRABLE_ADMIN_ACTION_TYPE = z.enum([
	'kill',
	'kick',
	'timeout',
	'remove-from-squad',
	'disband-squad',
	'demote-commander',
])
export type RequirableAdminActionType = z.infer<typeof REQUIRABLE_ADMIN_ACTION_TYPE>

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
	// the AdminKick reason string carries the text, for both plain kicks and timeouts
	'kick': { displayName: 'Kick', targetKind: 'players', permission: 'squad-server:kick-players', reasonDelivery: 'native' },
	'timeout': { displayName: 'Timeout', targetKind: 'players', permission: 'squad-server:timeout-players', reasonDelivery: 'native' },
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

export const AdminActionReasonSchema = LP.LabeledPresetSchema.omit({ message: true }).extend({
	// per-action text; a reason applies to an action iff it has text here
	actionTexts: z.partialRecord(ADMIN_ACTION_TYPE, z.string().trim().min(1)).prefault({}).describe(
		'Per-action text. The reason is available for an action only if it has text for that action.',
	),
}).refine((r) => Object.keys(r.actionTexts).length > 0, {
	error: 'A reason must have text for at least one action',
	path: ['actionTexts'],
})
export type AdminActionReason = z.infer<typeof AdminActionReasonSchema>

export const AdminActionReasonsSchema = z.array(AdminActionReasonSchema)
	.superRefine(LP.addLabelAliasUniquenessIssues)
	.prefault([])

export function reasonsForAction(reasons: AdminActionReason[], action: AdminActionType): AdminActionReason[] {
	return reasons.filter((r) => r.actionTexts[action] !== undefined)
}

// the text delivered for this action. Callers resolve applicability first (reasonsForAction / resolveReason),
// so the fallback is unreachable for a reason that's actually available for the action.
export function reasonText(action: AdminActionType, reason: AdminActionReason): string {
	return reason.actionTexts[action] ?? ''
}

export type ResolveReasonRes =
	| { code: 'ok'; reason: AdminActionReason }
	| { code: 'err:reason-not-found'; msg: string }
	| { code: 'err:reason-not-applicable'; msg: string }

export function resolveReason(reasons: AdminActionReason[], action: AdminActionType, token: string): ResolveReasonRes {
	const reason = LP.findByLabelOrAlias(reasons, token)
	if (!reason) return { code: 'err:reason-not-found', msg: `Admin action reason "${token}" no longer exists` }
	if (reason.actionTexts[action] === undefined) {
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
