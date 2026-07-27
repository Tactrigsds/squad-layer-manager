import { useMutation } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'
import { HexColorPicker } from 'react-colorful'

import { RichText } from '@/components/rich-text'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { UserLabel } from '@/components/user-avatar'
import { toast } from '@/lib/toast'
import { cn, REVEAL_ON_ITEM_HOVER } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as LTag_Msgs from '@/messages/layer-tags.messages'
import * as LTag from '@/models/layer-tags.models'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'

// The tag row shared by the queue item, the add-layers dialog and the paste-rotation dialog. It holds tag ids only:
// labels/colors are resolved against global settings at render, so an id whose tag has been deleted still renders
// (as the raw id) and can be taken off the item.

// lucide only ships tag-plus from v1, which is a major upgrade away from the version pinned here, so its icon data
// (ISC, lucide-react v1.26.0) is inlined rather than dragging every other icon through a rename audit
const TagPlus = Icons.createLucideIcon('tag-plus', [
	['path', { d: 'M16 13h6', key: '1um0mj' }],
	[
		'path',
		{
			d: 'm16.5 6.5-3.914-3.914A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l1.79-1.79',
			key: 'dp0yc9',
		},
	],
	['path', { d: 'M19 10v6', key: '13mz7b' }],
	['circle', { cx: '7.5', cy: '7.5', r: '.5', fill: 'currentColor', key: 'kqv944' }],
])

export function LayerTags(props: {
	tags: LTag.TagId[] | undefined
	// who put each tag on this item, where that's known. Absent in the dialogs, which tag items that don't exist yet.
	setBy?: LTag.Attribution
	onAdd: (tagId: LTag.TagId) => void
	onRemove: (tagId: LTag.TagId) => void
	disabled?: boolean
	className?: string
	// keeps the add button out of the way until the queue item is hovered or the button takes focus. Only meaningful
	// inside a `group/single-item`; the dialogs render the button unconditionally.
	revealAddOnHover?: boolean
}) {
	const configured = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.layerTags ?? [])
	const resolved = LTag.resolveAll(props.tags, configured)
	const canManage = useCanManageTags()
	const [editing, setEditing] = React.useState<LTag.Tag | 'new' | null>(null)

	const tagIds = props.tags ?? []
	const add = (id: LTag.TagId) => {
		if (tagIds.includes(id)) return
		props.onAdd(id)
	}

	return (
		<span className={cn('flex flex-wrap items-center gap-1', props.className)}>
			{resolved.map((tag) => (
				<TagChip
					key={tag.id}
					tag={tag}
					setBy={props.setBy?.[tag.id]}
					disabled={props.disabled}
					canManage={canManage}
					onRemove={() => props.onRemove(tag.id)}
					onEdit={() => setEditing(configured.find((t) => t.id === tag.id) ?? null)}
				/>
			))}
			<AddTagDropdown
				canManage={canManage}
				disabled={props.disabled}
				applied={tagIds}
				configured={configured}
				onSelect={add}
				onCreate={() => setEditing('new')}
				labelled={resolved.length === 0}
				revealOnHover={props.revealAddOnHover}
			/>
			<LayerTagDialog state={editing} onClose={() => setEditing(null)} onCreated={add} />
		</span>
	)
}

function TagChip(props: {
	tag: LTag.Resolved
	setBy?: USR.UserId
	disabled?: boolean
	canManage: boolean
	onRemove: () => void
	onEdit: () => void
}) {
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
					title={LTag_Msgs.removeTag(tag.label).text()}
					disabled={props.disabled}
					onClick={props.onRemove}
					className="ml-0.5 opacity-60 hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
				>
					<Icons.X className="h-3 w-3" />
				</button>
			</span>
			<HoverCardContent className="w-64 space-y-2 p-3">
				{tag.deleted ? (
					<p className="text-xs text-muted-foreground">{LTag_Msgs.deletedTag().text()}</p>
				) : (
					<>
						<p className="text-sm font-medium" style={{ color: tag.color }}>
							{tag.label}
						</p>
						<p className="text-xs text-muted-foreground">
							{tag.description ? (
								<RichText text={tag.description} />
							) : (
								<span className="italic">{LTag_Msgs.noDescription().text()}</span>
							)}
						</p>
						{props.canManage && (
							<Button variant="outline" size="sm" className="h-6 w-full text-xs" onClick={props.onEdit}>
								<Icons.Pencil className="mr-1 h-3 w-3" />
								{LTag_Msgs.editTag().text()}
							</Button>
						)}
					</>
				)}
				{props.setBy !== undefined && <UserLabel userId={props.setBy} label={LTag_Msgs.taggedBy().text()} />}
			</HoverCardContent>
		</HoverCard>
	)
}

function AddTagDropdown(props: {
	disabled?: boolean
	canManage: boolean
	applied: LTag.TagId[]
	configured: LTag.Tag[]
	onSelect: (id: LTag.TagId) => void
	onCreate: () => void
	labelled?: boolean
	revealOnHover?: boolean
}) {
	const available = props.configured.filter((t) => !props.applied.includes(t.id))
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={props.disabled}>
				<Button
					variant="ghost"
					size="sm"
					title={LTag_Msgs.addTag().text()}
					className={cn(
						'h-4 shrink-0 px-1 text-xs text-muted-foreground font-normal',
						props.labelled ? 'gap-0.5' : 'w-4 px-0',
						// data-[state=open] keeps it visible while its own menu is up, once the pointer leaves the item
						props.revealOnHover && [
							REVEAL_ON_ITEM_HOVER,
							'data-[state=open]:w-auto data-[state=open]:px-1 data-[state=open]:opacity-100',
						],
					)}
				>
					<TagPlus className="h-3 w-3" />
					{props.labelled && <span>{LTag_Msgs.addTagInline().text()}</span>}
				</Button>
			</DropdownMenuTrigger>
			{/* a description runs to note length, so the menu holds it to one clipped line and reads in full on the chip's hover card */}
			<DropdownMenuContent align="start" className="max-h-72 max-w-72 overflow-y-auto">
				{available.map((tag) => (
					<DropdownMenuItem key={tag.id} onSelect={() => props.onSelect(tag.id)}>
						<span className="mr-2 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
						<span className="flex min-w-0 flex-col">
							<span className="truncate text-xs">{tag.label}</span>
							{tag.description && <span className="truncate text-2xs text-muted-foreground">{tag.description}</span>}
						</span>
					</DropdownMenuItem>
				))}
				{available.length === 0 && <DropdownMenuItem disabled>{LTag_Msgs.noTagsAvailable().text()}</DropdownMenuItem>}
				{props.canManage && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={props.onCreate}>
							<Icons.Plus className="mr-2 h-3 w-3" />
							{LTag_Msgs.newTagItem().text()}
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
	const configured = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.layerTags ?? [])
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

	const upsert = useMutation(
		RPC.orpc.settings.global.upsertLayerTag.mutationOptions({
			onSuccess: (res) => {
				if (res.code === 'ok') {
					if (isNew) props.onCreated(res.tag.id)
					props.onClose()
					return
				}
				if (res.code === 'err:duplicate-label') toast.error(...LTag_Msgs.duplicateLabel(res.message).toast())
				else if (res.code === 'err:invalid-settings') toast.error(...LTag_Msgs.invalidTag(res.message).toast())
				else RbacClient.handlePermissionDenied(res)
			},
			onError: () => toast.error(...LTag_Msgs.saveFailed().toast()),
		}),
	)

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
				<DialogTitle>{isNew ? LTag_Msgs.newTagTitle().text() : LTag_Msgs.editTag().text()}</DialogTitle>
				<DialogDescription>{isNew ? LTag_Msgs.newTagBlurb().text() : LTag_Msgs.editTagBlurb().text()}</DialogDescription>
			</DialogHeader>
			<div className="space-y-3">
				<div className="space-y-1">
					<Label htmlFor="layer-tag-label">{LTag_Msgs.labelColumn().text()}</Label>
					<Input
						id="layer-tag-label"
						autoFocus
						defaultValue={existing?.label ?? ''}
						maxLength={LTag.MAX_LABEL_LENGTH}
						onChange={(e) => setLabel(e.target.value)}
						placeholder={LTag_Msgs.labelPlaceholder().text()}
					/>
					{duplicate && <p className="text-xs text-destructive">{LTag_Msgs.duplicateLabelInline(trimmed).text()}</p>}
				</div>
				<div className="space-y-1">
					<Label htmlFor="layer-tag-description">{LTag_Msgs.descriptionColumn().text()}</Label>
					<Textarea
						id="layer-tag-description"
						ref={descriptionRef}
						defaultValue={existing?.description ?? ''}
						maxLength={LTag.MAX_DESCRIPTION_LENGTH}
						className="min-h-16 text-sm"
						placeholder={LTag_Msgs.descriptionPlaceholder().text()}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="layer-tag-color">{LTag_Msgs.colorColumn().text()}</Label>
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
								{trimmed || LTag_Msgs.previewLabel().text()}
							</span>
						</div>
					</div>
				</div>
			</div>
			<DialogFooter>
				<Button variant="outline" onClick={props.onClose}>
					{LTag_Msgs.cancel().text()}
				</Button>
				<Button disabled={!canSave} onClick={submit}>
					{isNew ? LTag_Msgs.create().text() : LTag_Msgs.save().text()}
				</Button>
			</DialogFooter>
		</>
	)
}

function useCanManageTags() {
	return !RbacClient.usePermsCheck(RBAC.perm('queue:manage-tags'))
}
