import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDebouncedState } from '@/hooks/use-debounce'
import * as DH from '@/lib/display-helpers'
import { Focusable } from '@/lib/react'
import * as ReactRxHelpers from '@/lib/react-rxjs-helpers'
import { assertNever } from '@/lib/type-guards'
import * as Typo from '@/lib/typography'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models.ts'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as GlobalSettings from '@/systems.client/global-settings'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as QD from '@/systems.client/queue-dashboard'
import { useLoggedInUser } from '@/systems.client/users.client'
import { ColumnDef, createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, OnChangeFn, PaginationState, Row, RowSelectionState, SortDirection, useReactTable, VisibilityState } from '@tanstack/react-table'
import * as Im from 'immer'
import * as Icons from 'lucide-react'
import { ArrowDown, ArrowUp, ArrowUpDown, Dices, LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import React from 'react'
import { flushSync } from 'react-dom'
import * as Zus from 'zustand'
import { ConstraintDisplay } from './constraint-display'
import { LayerContextMenuItems } from './layer-table-helpers'
import MapLayerDisplay from './map-layer-display'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'
export type { PostProcessedLayer } from '@/systems.shared/layer-queries.shared'

type InputArgs = {
	pageSize?: number
	sort?: LQY.LayersQueryInput['sort']
	visibleColumns?: string[]
	colConfig: LQY.EffectiveColumnAndTableConfig
}

export type Input = {
	pageSize: number
	sort: LQY.LayersQueryInput['sort']
	visibleColumns: string[]
	colConfig: LQY.EffectiveColumnAndTableConfig
}

export function getInputDefaults(args: InputArgs) {
	return ({
		pageSize: args.pageSize ?? 10,
		sort: args.sort ?? [],
		visibleColumns: args.visibleColumns ?? [],
		colConfig: args.colConfig,
	})
}

type LayerTable = {
	// make sure this reference is stable
	baseInput?: LQY.BaseQueryInput

	selected: L.LayerId[]
	setSelected: React.Dispatch<React.SetStateAction<L.LayerId[]>>
	resetSelected?: () => void
	enableForceSelect?: boolean

	pageIndex: number
	// make sure this reference is stable
	setPageIndex: (num: number) => void
	pageSize: number
	setPageSize: (num: number) => void

	editingSingleValue?: boolean

	extraPanelItems?: React.ReactNode
	errorStore?: Zus.StoreApi<F.NodeValidationErrorStore>

	// from hooks
	setShowSelectedLayers: React.Dispatch<React.SetStateAction<boolean>>
	setSorting: (state: LQY.LayersQueryInput['sort']) => void
	reseed: () => void
}

type ExtendedSortingState = Array<{ id: string; desc: boolean; abs?: boolean }>
export function selectExtendedSortingState(table: LayerTable): ExtendedSortingState {
}

// display props
// canChangeRowsPerPage?: boolean
// 	canToggleColumns?: boolean
