import * as SchemaModels from '$root/drizzle/schema.models'
import * as L from '@/models/layer'
import deepEqual from 'fast-deep-equal'
import { z } from 'zod'

export const LAYER_NOTE_APPLIES_TO_CATEGORY = z.enum(['factions', 'layer'])
export type LayerNoteAppliesToCategory = z.infer<typeof LAYER_NOTE_APPLIES_TO_CATEGORY>

// make sure we keep this backwards-compatible
export function deserializeAppliesTo(serialized: number): LayerNoteAppliesToCategory[] {
	switch (serialized) {
		case 0:
			return ['factions', 'layer']
		case 1:
			return ['factions']
		case 2:
			return ['layer']
		default:
			throw new Error(` Invalid appliesTo categories: ${serialized}`)
	}
}

// make sure we keep this backwards-compatible
export function serializeAppliesTo(categories: LayerNoteAppliesToCategory[]): number {
	if (deepEqual(categories, ['factions', 'layer'])) {
		return 0
	} else if (deepEqual(categories, ['factions'])) {
		return 1
	} else if (deepEqual(categories, ['layer'])) {
		return 2
	}
	throw new Error(` Invalid appliesTo categories: ${JSON.stringify(categories)}`)
}

export const VALENCE = z.enum(['neutral', 'very-positive', 'positive', 'negative', 'very-negative'])
export type Valence = z.infer<typeof VALENCE>

export function serializeValence(valence: Valence) {
	return VALENCE.options.indexOf(valence)
}

export function deserializeValence(valence: number) {
	const option = VALENCE.options[valence]
	if (option === undefined) throw new Error(`Invalid valence: ${valence}`)
	return option
}

export type NewLayerNote = {
	layerId: L.LayerId
	discordId: bigint
	appliesTo: LayerNoteAppliesToCategory[]
	valence: Valence
	note: string | null
}
export type LayerNote = NewLayerNote & {
	id: number
	rowTimestamp: Date
}

export function toNewRow(note: NewLayerNote): SchemaModels.NewLayerNote {
	const [layer, team1, team2] = L.getLayerCommand(note.layerId, 'none').split(' ')
	return {
		layer,
		team1,
		team2,
		discordId: note.discordId,
		appliesTo: serializeAppliesTo(note.appliesTo),
		valence: serializeValence(note.valence),
		note: note.note,
	}
}

export function fromRow(row: SchemaModels.LayerNote): LayerNote {
	const layer = L.parseRawLayerText(`${row.layer} ${row.team1} ${row.team1}`.trim())
	if (!layer) throw new Error(`Invalid layer: ${row.layer} ${row.team1} ${row.team2}`)
	return {
		id: row.id,
		layerId: layer.id,
		discordId: row.discordId,
		appliesTo: deserializeAppliesTo(row.appliesTo),
		valence: deserializeValence(row.valence),
		note: row.note,
		rowTimestamp: row.rowTimestamp,
	}
}
