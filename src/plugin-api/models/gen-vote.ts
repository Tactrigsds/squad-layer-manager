/**
 * Drawing the choices of a vote. A choice is either a layer you picked or a set of constraints to draw one
 * from, and `uniqueConstraints` names the properties the drawn choices must differ on, so a vote does not
 * offer the same map three times.
 *
 * `genVote` in slm/systems/layer-queries does the drawing. Running the vote itself belongs to the host.
 */
import type * as LQY from '@/models/layer-queries.models'
import * as V from '@/models/vote.models'

export type Input = LQY.GenVote.Input
export type Choice = V.GenVote.Choice
export type ChoiceConstraints = V.GenVote.ChoiceConstraints
export type ChoiceConstraintKey = V.GenVote.ChoiceConstraintKey

export const CHOICE_CONSTRAINT_KEYS = V.GenVote.CHOICE_COMPARISON_KEY
export const DEFAULT_UNIQUE_CONSTRAINTS = V.GenVote.DEFAULT_CHOICE_COMPARISONS
export const initChoice = V.GenVote.initChoice
/** The values a choice constraint accepts, for the key it constrains. */
export const choiceConstraintAllowedValues = V.GenVote.choiceConstraintAllowedValues
