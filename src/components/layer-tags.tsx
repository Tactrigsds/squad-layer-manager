import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as LTag from '@/models/layer-tags.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import { HexColorPicker } from 'react-colorful'

// The tag row shared by the queue item, the add-layers dialog and the paste-rotation dialog. It holds tag ids only:
// labels/colors are resolved against global settings at render, so an id whose tag has been deleted still renders
// (as the raw id) and can be taken off the item.

export function LayerTags(props: {
	tags: LTag.TagId[] | undefined
	onChange: (tags: LTag.TagId[]) => void
	disabled?: boolean
	className?: string
	// keeps the add button out of the way until the queue item is hovered or the button takes focus. Only meaningful
	// inside a `group/single-item`; the dialogs render the button unconditionally.
	revealAddOnHover?: boolean
}) {
	const configured = ZusUtils.useStore(SettingsClient.PublicSettingsStore, s => s?.layerTags ?? [])
	const resolved = LTag.resolveAll(props.tags, configured)
	const [editing, setEditing] = React.useState<LTag.Tag | 'new' | null>(null)

	const tagIds = props.tags ?? []
	const remove = (id: LTag.TagId) => props.onChange(tagIds.filter(t => t !== id))
	const add = (id: LTag.TagId) => {
		if (tagIds.includes(id)) return
		props.onChange([...tagIds, id])
	}

	return (
		<span className={cn('flex flex-wrap items-center gap-1', props.className)}>
			{resolved.map(tag => (
				<TagChip
					key={tag.id}
					tag={tag}
					disabled={props.disabled}
					onRemove={() => remove(tag.id)}
					onEdit={() => setEditing(configured.find(t => t.id === tag.id) ?? null)}
				/>
			))}
			<AddTagDropdown
				disabled={props.disabled}
				applied={tagIds}
				configured={configured}
				onSelect={add}
				onCreate={() => setEditing('new')}
				labelled={resolved.length === 0}
				revealOnHover={props.revealAddOnHover}
			/>
			<LayerTagDialog
				state={editing}
				onClose={() => setEditing(null)}
				onCreated={add}
			/>
		</span>
	)
}

function TagChip(props: { tag: LTag.Resolved; disabled?: boolean; onRemove: () => void; onEdit: () => void }) {
	const { tag } = props
	// an interactive hover card rather than a Tooltip: the edit affordance lives inside it, and tooltips in this app are
	// explicitly for non-interactive content (see ZI_OFFSETS.TOOLTIP)
	return (
		<HoverCard openDelay={200}>
			<span
				className="inline-flex items-center rounded-sm border px-1 text-xs leading-4"
				style={{ borderColor: `${tag.color}80`, backgroundColor: `${tag.color}1a`, color: tag.color }}
			>
				<HoverCardTrigger asChild>
					<span className={cn('cursor-default select-none', tag.deleted && 'line-through')}>{tag.label}</span>
				</HoverCardTrigger>
				<button
					type="button"
					title={`Remove ${tag.label}`}
					disabled={props.disabled}
					onClick={props.onRemove}
					className="ml-0.5 opacity-60 hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
				>
					<Icons.X className="h-3 w-3" />
				</button>
			</span>
			<HoverCardContent className="w-64 space-y-2 p-3">
				{tag.deleted
					? (
						<p className="text-xs text-muted-foreground">
							This tag has been deleted, so only the id it was created with remains. It can still be removed from the layer.
						</p>
					)
					: (
						<>
							<p className="text-sm font-medium" style={{ color: tag.color }}>{tag.label}</p>
							<p className="text-xs text-muted-foreground">
								{tag.description || <span className="italic">No description</span>}
							</p>
							<Button variant="outline" size="sm" className="h-6 w-full text-xs" onClick={props.onEdit}>
								<Icons.Pencil className="mr-1 h-3 w-3" />
								Edit tag
							</Button>
						</>
					)}
			</HoverCardContent>
		</HoverCard>
	)
}

function AddTagDropdown(props: {
	disabled?: boolean
	applied: LTag.TagId[]
	configured: LTag.Tag[]
	onSelect: (id: LTag.TagId) => void
	onCreate: () => void
	labelled?: boolean
	revealOnHover?: boolean
}) {
	const canManage = useCanManageTags()
	const available = props.configured.filter(t => !props.applied.includes(t.id))
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={props.disabled}>
				<Button
					variant="ghost"
					size="sm"
					title="Add tag"
					className={cn(
						'h-4 shrink-0 px-1 text-xs text-muted-foreground font-normal',
						props.labelled ? 'gap-0.5' : 'w-4 px-0',
						// data-[state=open] keeps it visible while its own menu is up, once the pointer leaves the item
						props.revealOnHover
							&& 'opacity-0 group-hover/single-item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
					)}
				>
					<Icons.Plus className="h-3 w-3" />
					{props.labelled && <span>add tag</span>}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
				{available.map(tag => (
					<DropdownMenuItem key={tag.id} onSelect={() => props.onSelect(tag.id)}>
						<span className="mr-2 h-2 w-2 rounded-full" style={{ backgroundColor: tag.color }} />
						<span className="flex flex-col">
							<span className="text-xs">{tag.label}</span>
							{tag.description && <span className="text-2xs text-muted-foreground">{tag.description}</span>}
						</span>
					</DropdownMenuItem>
				))}
				{available.length === 0 && <DropdownMenuItem disabled>No tags available</DropdownMenuItem>}
				{canManage && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={props.onCreate}>
							<Icons.Plus className="mr-2 h-3 w-3" />
							New tag...
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function LayerTagDialog(props: { state: LTag.Tag | 'new' | null; onClose: () => void; onCreated: (id: LTag.TagId) => void }) {
	const open = props.state !== null
	// remounting per open is what regenerates the suggested colour for a new tag and reseeds the fields for an edit
	return (
		<Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent className="max-w-sm">
				{props.state && <LayerTagDialogBody key={props.state === 'new' ? 'new' : props.state.id} {...props} state={props.state} />}
			</DialogContent>
		</Dialog>
	)
}

function LayerTagDialogBody(props: { state: LTag.Tag | 'new'; onClose: () => void; onCreated: (id: LTag.TagId) => void }) {
	const configured = ZusUtils.useStore(SettingsClient.PublicSettingsStore, s => s?.layerTags ?? [])
	const existing = props.state === 'new' ? undefined : props.state
	const isNew = existing === undefined

	const [label, setLabel] = React.useState(existing?.label ?? '')
	const [color, setColor] = React.useState(() => existing?.color ?? LTag.suggestColor(configured))
	const descriptionRef = React.useRef<HTMLTextAreaElement>(null)
	const hexRef = React.useRef<HTMLInputElement>(null)

	const setColorFromPicker = (next: string) => {
		setColor(next)
		if (hexRef.current) hexRef.current.value = next
	}

	const upsert = useMutation(RPC.orpc.settings.global.upsertLayerTag.mutationOptions({
		onSuccess: (res) => {
			if (res.code === 'ok') {
				if (isNew) props.onCreated(res.tag.id)
				props.onClose()
				return
			}
			if (res.code === 'err:duplicate-label') toast.error('Duplicate label', { description: res.message })
			else if (res.code === 'err:invalid-settings') toast.error('Invalid tag', { description: res.message })
			else RbacClient.handlePermissionDenied(res)
		},
		onError: () => toast.error('Failed to save tag'),
	}))

	const trimmed = label.trim()
	const duplicate = LTag.labelConflict(configured, trimmed, existing?.id)
	const canSave = trimmed.length > 0 && !duplicate && /^#[0-9a-fA-F]{6}$/.test(color) && !upsert.isPending

	const submit = () => {
		if (!canSave) return
		void upsert.mutateAsync({
			id: existing?.id ?? LTag.createTagId(trimmed),
			label: trimmed,
			description: descriptionRef.current?.value.trim() ?? '',
			color,
		})
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle>{isNew ? 'New tag' : 'Edit tag'}</DialogTitle>
				<DialogDescription>
					{isNew
						? 'Tags are shared by everyone and can be attached to any layer in the queue.'
						: 'Renaming a tag keeps it attached to every layer already carrying it.'}
				</DialogDescription>
			</DialogHeader>
			<div className="space-y-3">
				<div className="space-y-1">
					<Label htmlFor="layer-tag-label">Label</Label>
					<Input
						id="layer-tag-label"
						autoFocus
						defaultValue={existing?.label ?? ''}
						maxLength={LTag.MAX_LABEL_LENGTH}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="e.g. meta"
					/>
					{duplicate && <p className="text-xs text-destructive">Another tag is already labeled "{trimmed}"</p>}
				</div>
				<div className="space-y-1">
					<Label htmlFor="layer-tag-description">Description</Label>
					<Textarea
						id="layer-tag-description"
						ref={descriptionRef}
						defaultValue={existing?.description ?? ''}
						maxLength={LTag.MAX_DESCRIPTION_LENGTH}
						className="min-h-16 text-sm"
						placeholder="Shown when hovering the tag"
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="layer-tag-color">Color</Label>
					<div className="flex items-start space-x-2">
						<HexColorPicker color={color} onChange={setColorFromPicker} style={{ width: 140, height: 110 }} />
						<div className="space-y-1">
							<Input
								id="layer-tag-color"
								ref={hexRef}
								defaultValue={color}
								maxLength={7}
								className="w-24 font-mono text-xs"
								onChange={(e) => setColor(e.target.value.trim())}
							/>
							<span
								className="inline-flex items-center rounded-sm border px-1 text-xs leading-4"
								style={{ borderColor: `${color}80`, backgroundColor: `${color}1a`, color }}
							>
								{trimmed || 'preview'}
							</span>
						</div>
					</div>
				</div>
			</div>
			<DialogFooter>
				<Button variant="outline" onClick={props.onClose}>Cancel</Button>
				<Button disabled={!canSave} onClick={submit}>{isNew ? 'Create' : 'Save'}</Button>
			</DialogFooter>
		</>
	)
}

function useCanManageTags() {
	const access = RbacClient.useGlobalSettingsAccess()
	return RBAC.settingsPathAllowed(access.write, 'layerTags')
}
