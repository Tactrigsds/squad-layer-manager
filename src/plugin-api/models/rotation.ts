/**
 * Rotations: saved, ordered lists of queue items that admins add to a server's queue in one go. A rotation's items
 * carry no attribution, so whatever a plugin writes is stored without sources, tag attribution or note authors.
 *
 * A Summary is a rotation without its items, as searching returns it. The export formats stay with the host.
 */
export {
	DescriptionSchema,
	MetaPatchSchema,
	NameSchema,
	NewRotationSchema,
	OwnerSchema,
	PREVIEW_ITEMS,
	RotationIdSchema,
	RotationSchema,
	SearchCursorSchema,
	SearchInputSchema,
	UpdatePatchSchema,
} from '@/models/rotations.models'
export type {
	IndexSort,
	MetaPatch,
	NewRotation,
	Owner,
	Rotation,
	RotationId,
	SearchCursor,
	SearchInput,
	SearchPage,
	Summary,
	UpdatePatch,
} from '@/models/rotations.models'
// the items a rotation is made of, which are queue items
export type { Item, List, NewItem, SingleItem, VoteItem } from '@/models/layer-list.models'
