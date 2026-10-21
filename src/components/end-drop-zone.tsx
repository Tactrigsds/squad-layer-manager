import type React from 'react'

import { cn } from '@/lib/utils'
import type * as DND from '@/models/dndkit.models'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex.models'
import * as DndKit from '@/systems/dndkit.client'
import * as LLDnd from '@/systems/layer-list-dnd.client'

// A drop target over the end of a list row, shown during a drag. The row must be positioned, and should hide what the
// zone covers with `group-has-[[data-end-drop-zone]]:invisible`. The label shows only while the zone is the target.
export function EndDropZone(props: { dropItem: DND.DropItem; icon: React.ReactNode; label: string; tone?: 'pri' | 'danger' }) {
	const { ref, isDropTarget } = DndKit.useDroppable(props.dropItem, { collisionDetector: LLDnd.pointerInRectCollision })
	const zIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)
	return (
		<span
			ref={ref}
			data-end-drop-zone=""
			data-is-over={isDropTarget}
			style={{ zIndex }}
			className={cn(
				'group/end-zone absolute inset-y-0 end-0 flex w-1/4 max-phone:w-2/5 items-center gap-1.5 border-s-2 border-transparent bg-ground bg-linear-to-b px-2 text-sm text-text-3 data-[is-over=true]:text-text [&_svg]:size-4 [&_svg]:shrink-0',
				props.tone === 'danger'
					? 'from-danger/6 to-danger/6 data-[is-over=true]:border-danger data-[is-over=true]:from-danger/25 data-[is-over=true]:to-danger/25'
					: 'from-pri/6 to-pri/6 data-[is-over=true]:border-pri data-[is-over=true]:from-pri/25 data-[is-over=true]:to-pri/25',
			)}
		>
			{props.icon}
			<span className="hidden min-w-0 truncate group-data-[is-over=true]/end-zone:inline">{props.label}</span>
		</span>
	)
}
