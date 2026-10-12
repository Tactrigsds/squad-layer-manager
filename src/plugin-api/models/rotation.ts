/**
 * Rotations: saved, ordered lists of queue items that admins add to a server's queue in one go. A rotation's items
 * carry no attribution, so whatever a plugin writes is stored without sources, tag attribution or note authors.
 *
 * The rotations page's search and the export formats stay with the host.
 */
export {
	DescriptionSchema,
	MetaPatchSchema,
	NameSchema,
	NewRotationSchema,
	OwnerSchema,
	RotationIdSchema,
	RotationSchema,
	UpdatePatchSchema,
} from '@/models/rotations.models'
export type { MetaPatch, NewRotation, Owner, Rotation, RotationId, UpdatePatch } from '@/models/rotations.models'
// the items a rotation is made of, which are queue items
export type { Item, List, NewItem, SingleItem, VoteItem } from '@/models/layer-list.models'
