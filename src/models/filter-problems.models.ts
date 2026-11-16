import * as FR from '@/models/filter-references.models'
import type * as F from '@/models/filter.models'
import type * as LQY from '@/models/layer-queries.models'
import type { TString } from '@/models/messages.models'
import type * as SETTINGS from '@/models/settings.models'

// Display shapes for filters that cannot be applied, read off the attributed errors a query or the problem index
// reports. One line per failing node, named by the stored filter that holds it.

export type ProblemLine = {
	key: string
	// the stored filter holding the failing node. null when the node is in a tree that is not a stored filter
	filterId: F.FilterEntityId | null
	// the filter that reaches filterId through apply-filter nodes, when it is another one
	viaFilterId: F.FilterEntityId | null
	part: F.FilterPart
	// the `node` search param of the filter's edit page, or null for the root
	node: string | null
	msg: TString
	// what the failing tree was, for a line with no stored filter to name
	constraintType: LQY.Constraint['type'] | null
}

export type ConfigProblemRow = {
	key: string
	// null for the row of the server's installed mods
	filterId: F.FilterEntityId | null
	// the lists of the pool configuration that name the filter
	uses: FR.PoolConfigKey[]
	lines: ProblemLine[]
}

// the fields of a lowering error that a problem line reads, which a recorded app event keeps too
export type LineSource = Pick<F.NodeValidationError, 'ownerFilterId' | 'part' | 'path' | 'msg'> & { type: string }

export function errorLines(
	errors: readonly LineSource[],
	// rootFilterId: the stored filter whose tree the errors were reached from
	opts?: { constraintType?: LQY.Constraint['type']; rootFilterId?: F.FilterEntityId; seen?: Set<string> },
): ProblemLine[] {
	const seen = opts?.seen ?? new Set<string>()
	const lines: ProblemLine[] = []
	for (const error of errors) {
		const viaFilterId = opts?.rootFilterId && opts.rootFilterId !== error.ownerFilterId ? opts.rootFilterId : null
		const key = `${viaFilterId}|${error.ownerFilterId}|${error.part}|${error.path.join('.')}|${error.type}`
		if (seen.has(key)) continue
		seen.add(key)
		lines.push({
			key,
			filterId: error.ownerFilterId,
			viaFilterId,
			part: error.part,
			node: error.path.length > 0 ? error.path.join('.') : null,
			msg: error.msg,
			constraintType: error.ownerFilterId === null ? (opts?.constraintType ?? null) : null,
		})
	}
	return lines
}

// the same failing node reached through several constraints is listed once
export function problemLines(problems: readonly LQY.ConstraintProblem[]): ProblemLine[] {
	const seen = new Set<string>()
	return problems.flatMap((problem) =>
		errorLines(problem.errors, { constraintType: problem.constraintType, rootFilterId: problem.filterId, seen }),
	)
}

// The problems that left a constraint out of a result. A miss exemption that cannot be applied is not one: its filter
// still applies, and exempts no layers.
export function skippedProblems(problems: LQY.ConstraintProblem[]): LQY.ConstraintProblem[] {
	return problems.every((problem) => problem.part === 'filter') ? problems : problems.filter((problem) => problem.part === 'filter')
}

// `constraints` without those a result skipped
export function withoutSkipped(constraints: LQY.Constraint[], problems: readonly LQY.ConstraintProblem[]): LQY.Constraint[] {
	const skipped = new Set<string>()
	for (const problem of problems) if (problem.part === 'filter') skipped.add(problem.constraintId)
	if (skipped.size === 0) return constraints
	return constraints.filter((constraint) => !skipped.has(constraint.id))
}

// the configured filters a result was computed without, each once
export function skippedFilterIds(problems: LQY.ConstraintProblem[]): F.FilterEntityId[] {
	const ids = new Set<F.FilterEntityId>()
	for (const problem of skippedProblems(problems)) {
		if (problem.filterId) ids.add(problem.filterId)
		else for (const error of problem.errors) if (error.ownerFilterId) ids.add(error.ownerFilterId)
	}
	return [...ids]
}

// the skipped constraints that narrow the results, leaving out those shown only as indicators
export function appliedProblems(problems: LQY.ConstraintProblem[], constraints: readonly LQY.Constraint[] | undefined) {
	const applied = problems.filter(
		(problem) =>
			problem.part === 'filter' &&
			constraints?.find((constraint) => constraint.id === problem.constraintId)?.filterApplState !== 'disabled',
	)
	return applied.length === problems.length ? problems : applied
}

// how many filters, or other constraints such as the installed mods, a result was computed without
export function skippedCount(problems: LQY.ConstraintProblem[]) {
	return new Set(skippedProblems(problems).map((problem) => problem.filterId ?? problem.constraintId)).size
}

// One row per broken filter that a server's pool configuration names, then one for its installed mods when the layer
// data lacks any of them
export function configProblemRows(
	filterErrors: Readonly<Record<F.FilterEntityId, readonly LineSource[]>>,
	installedModErrors: readonly LineSource[],
	pool: SETTINGS.PoolConfiguration,
): ConfigProblemRow[] {
	const rows = new Map<F.FilterEntityId, ConfigProblemRow>()
	for (const key of FR.POOL_CONFIG_KEYS) {
		for (const filterId of FR.poolConfigFilterIds(pool, key)) {
			const errors = filterErrors[filterId]
			if (!errors) continue
			const row = rows.get(filterId)
			if (!row) rows.set(filterId, { key: filterId, filterId, uses: [key], lines: errorLines(errors) })
			else if (!row.uses.includes(key)) row.uses.push(key)
		}
	}
	const result = [...rows.values()]
	if (installedModErrors.length > 0) {
		result.push({
			key: 'installed-mods',
			filterId: null,
			uses: [],
			lines: errorLines(installedModErrors, { constraintType: 'installed-mods' }),
		})
	}
	return result
}
