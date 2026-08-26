/**
 * Builders for the constraints a layer query takes. Each says what a filter or repeat rule does to the
 * query: narrow it, invert it, leave it unapplied but report per-row membership, warn on a violation.
 *
 * The `id` you give a constraint comes back on every warning and match descriptor it produces, which is
 * how you tell which of your constraints a result is about.
 */
export { filterAnon, filterEntity, filterMenuItems, poolFilter, repeatRule } from '@/models/constraint-builders'
