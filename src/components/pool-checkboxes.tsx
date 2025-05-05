import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useLayerStatuses } from '@/hooks/use-layer-queries.ts'
import * as DH from '@/lib/display-helpers'
import { initMutationState } from '@/lib/item-mutations.ts'
import { getDisplayedMutation } from '@/lib/item-mutations.ts'
import * as Text from '@/lib/text'
import { assertNever } from '@/lib/typeGuards.ts'
import * as Typography from '@/lib/typography.ts'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand.ts'
import * as M from '@/models'
import { DragContextProvider } from '@/systems.client/dndkit.provider.tsx'
import { useDragEnd } from '@/systems.client/dndkit.ts'
import { useLoggedInUser } from '@/systems.client/logged-in-user'
import * as PartsSys from '@/systems.client/parts.ts'
import * as QD from '@/systems.client/queue-dashboard.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as DndKit from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import deepEqual from 'fast-deep-equal'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import LayerDisplay from './layer-display.tsx'
import LayerFilterMenu, { useFilterMenuStore, useQueryContextWithMenuFilter } from './layer-filter-menu.tsx'
import LayerSourceDisplay from './layer-source-display.tsx'
import SelectLayersDialog from './select-layers-dialog.tsx'
import TableStyleLayerPicker from './table-style-layer-picker.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu.tsx'
import { Label } from './ui/label.tsx'
import TabsList from './ui/tabs-list.tsx'

export default function PoolCheckboxes() {
	const [poolApplyAs, setPoolApplyAs] = Zus.useStore(QD.QDStore, useShallow(s => [s.poolApplyAs, s.setPoolApplyAs]))
	const dnrCheckboxId = React.useId()
	const filterCheckboxId = React.useId()

	return (
		<>
			<div className="flex items-center flex-nowrap space-x-0.5">
				<Label htmlFor={dnrCheckboxId}>Hide Repeated</Label>
				<Checkbox
					id={dnrCheckboxId}
					onCheckedChange={v => {
						if (v === 'indeterminate') return
						setPoolApplyAs('dnr', v ? 'where-condition' : 'field')
					}}
					checked={poolApplyAs.dnr === 'where-condition'}
				/>
			</div>
			<div className="flex items-center flex-nowrap space-x-0.5">
				<Label htmlFor={filterCheckboxId}>Hide Filtered</Label>
				<Checkbox
					id={filterCheckboxId}
					onCheckedChange={v => {
						if (v === 'indeterminate') return
						setPoolApplyAs('filter', v ? 'where-condition' : 'field')
					}}
					checked={poolApplyAs.filter === 'where-condition'}
				/>
			</div>
		</>
	)
}
