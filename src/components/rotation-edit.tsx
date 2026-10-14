import { useQuery } from '@tanstack/react-query'
import { Link, useBlocker, useNavigate } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import { ContributorsPopover } from '@/components/contributors-popover'
import { LayerList } from '@/components/layer-list'
import { LayerTags } from '@/components/layer-tags'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { RepeatRulesetPanel } from '@/components/pool-config-panels'
import * as Typo from '@/components/typography'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import TabsList from '@/components/ui/tabs-list'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as ListHostPrt from '@/frame-partials/list-host.partial'
import { useFrameLifecycle } from '@/frames/frame-manager'
import * as RepeatRulesetEditorFrame from '@/frames/repeat-ruleset-editor.frame'
import * as RotationEditorFrame from '@/frames/rotation-editor.frame'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as LL_Msgs from '@/messages/layer-list.messages'
import * as ROT_Msgs from '@/messages/rotations.messages'
import * as UI_Msgs from '@/messages/ui.messages'
import type * as LL from '@/models/layer-list.models'
import * as ROT from '@/models/rotations.models'
import * as UP from '@/models/user-presence.models'
import { useZIndex, ZI_OFFSETS } from '@/models/zindex.models'
import * as RBAC from '@/rbac.models'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
import * as PartsSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'
import * as RotationClient from '@/systems/rotation.client'
import * as UPClient from '@/systems/user-presence.client'

import { StartActivityInteraction } from './activity'
import { DeleteRotationDialog, RotationFormDialog } from './rotation-dialogs'

const RotationSourceEditor = React.lazy(() => import('./rotation-source-editor'))

export default function RotationEdit(props: { rotationId: ROT.RotationId }) {
	const rotation = RotationClient.useRotation(props.rotationId)
	if (rotation === undefined) return null
	if (rotation === null) return <p className="container mx-auto py-8">{tr.text(ROT_Msgs.notFound())}</p>
	return <RotationEditLoaded rotation={rotation} />
}

function RotationEditLoaded(props: { rotation: ROT.Rotation }) {
	const { rotation } = props
	const navigate = useNavigate()
	const listHost = useFrameLifecycle(RotationEditorFrame.frame, { input: RotationEditorFrame.createInput(rotation.id) })
	const repeatRulesetEditor = useFrameLifecycle(RepeatRulesetEditorFrame.frame, {
		input: { source: { type: 'rotation', rotationId: rotation.id } },
	})
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForRotation(rotation.id))
	const manageDenied = RbacClient.usePermsCheck(RBAC.getManagePermReqForRotation(rotation.id))
	const createDenied = RbacClient.usePermsCheck(RBAC.perm('rotations:create'))
	const [dialog, setDialog] = React.useState<'name' | 'description' | 'clone' | 'delete' | null>(null)

	// leaving loses the user's edits to the shared draft and unsaved repeat rules, so it asks first, as the filter editor does
	const [isEditing] = UPClient.useActivityState(UP.Trans.editingRotation(rotation.id))
	const listModified = Zus.useStore(listHost, (s) => s.queue.isModified)
	const rulesModified = Zus.useStore(repeatRulesetEditor, (s) => s.modified)
	const unsaved = (isEditing && listModified) || rulesModified
	useBlocker({
		enableBeforeUnload: unsaved,
		shouldBlockFn: () => unsaved && !confirm(tr.text(ROT_Msgs.unsavedChangesConfirm())),
	})
	const ownerName = FilterEntityClient.useOwnerName(rotation.owner)

	return (
		<div className="container mx-auto py-4 px-4 space-y-4">
			<header className="flex flex-wrap items-center gap-3 border-b pb-3">
				<Link to="/rotations" className="text-sm text-muted-foreground hover:underline">
					‹ {tr.text(ROT_Msgs.pageTitle())}
				</Link>
				<h2 className={cn(Typo.H2, 'min-w-0 truncate')}>{rotation.name}</h2>
				<EditFieldButton label={tr.text(ROT_Msgs.editName())} denied={writeDenied} onClick={() => setDialog('name')} />
				<span className="font-mono text-xs text-muted-foreground">{rotation.id}</span>
				{rotation.archived && <Badge variant="secondary">{tr.text(ROT_Msgs.archivedBadge())}</Badge>}
				<span className="text-sm text-muted-foreground">{tr.text(ROT_Msgs.ownerLabel(ownerName ?? ''))}</span>
				<RotationContributors rotationId={rotation.id} canManage={!manageDenied} />
			</header>

			<LiveBar listHost={listHost} host={{ type: 'rotation', rotationId: rotation.id }} />

			<div className="flex flex-wrap items-start gap-x-6 gap-y-2">
				<div className="flex min-w-0 flex-[1_1_20rem] items-start gap-1">
					<p className={cn('min-w-0 whitespace-pre-wrap text-sm', !rotation.description && 'text-muted-foreground')}>
						{rotation.description ?? tr.text(ROT_Msgs.noDescription())}
					</p>
					<EditFieldButton label={tr.text(ROT_Msgs.editDescription())} denied={writeDenied} onClick={() => setDialog('description')} />
				</div>
				<div className="ms-auto">
					<RotationTagsRow rotation={rotation} disabled={!!writeDenied} />
				</div>
			</div>

			{/* one column puts the actions above the layers and the repeat ruleset below them. Two columns put both beside
			    the layers. */}
			<div className="@container">
				<div className="grid gap-4 [grid-template-areas:'actions'_'layers'_'ruleset'] @[960px]:grid-cols-[minmax(0,1fr)_fit-content(40%)] @[960px]:grid-rows-[auto_1fr] @[960px]:[grid-template-areas:'layers_actions'_'layers_ruleset']">
					<ListSection listHost={listHost} rotation={rotation}>
						<ListToolbar listHost={listHost} rotation={rotation} />
						<ListBody listHost={listHost} rotationId={rotation.id} />
					</ListSection>
					<OpenedFileDialog listHost={listHost} />

					<div className="flex flex-wrap content-start gap-1.5 [grid-area:actions]">
						<EditingControls listHost={listHost} rotationId={rotation.id} />
						<PermissionDeniedTooltip denied={createDenied}>
							<Button variant="outline" disabled={!!createDenied} onClick={() => setDialog('clone')}>
								<Icons.Copy />
								{tr.text(ROT_Msgs.clone())}
							</Button>
						</PermissionDeniedTooltip>
						<PermissionDeniedTooltip denied={writeDenied}>
							<Button
								variant="outline"
								disabled={!!writeDenied}
								onClick={() => void RotationClient.Actions.updateMeta(rotation.id, { archived: !rotation.archived })}
							>
								{rotation.archived ? <Icons.ArchiveRestore /> : <Icons.Archive />}
								{tr.text(rotation.archived ? ROT_Msgs.unarchive() : ROT_Msgs.archive())}
							</Button>
						</PermissionDeniedTooltip>
						<PermissionDeniedTooltip denied={manageDenied}>
							<Button variant="destructive" disabled={!!manageDenied} onClick={() => setDialog('delete')}>
								<Icons.Trash />
								{tr.text(ROT_Msgs.deleteRotation())}
							</Button>
						</PermissionDeniedTooltip>
					</div>
					<section className="min-w-0 self-start rounded border bg-card p-3 [grid-area:ruleset]">
						<RepeatRulesetPanel
							title={tr.text(ROT_Msgs.repeatRuleset())}
							help={tr.text(ROT_Msgs.repeatRulesetHelp())}
							repeatRulesetId={rotation.repeatRulesetId}
							selectDisabled={!!writeDenied}
							onSelect={(repeatRulesetId) => void RotationClient.Actions.updateMeta(rotation.id, { repeatRulesetId })}
							repeatRulesetEditor={repeatRulesetEditor}
							inlineSave
							rulesInDialog
						/>
					</section>
				</div>
			</div>

			{(dialog === 'name' || dialog === 'description') && (
				<FieldDialog rotation={rotation} field={dialog} onClose={() => setDialog(null)} />
			)}
			<RotationFormDialog
				mode="clone"
				source={rotation}
				open={dialog === 'clone'}
				onOpenChange={(open) => setDialog(open ? 'clone' : null)}
			/>
			<DeleteRotationDialog
				rotation={rotation}
				open={dialog === 'delete'}
				onOpenChange={(open) => setDialog(open ? 'delete' : null)}
				onDeleted={() => void navigate({ to: '/rotations', ignoreBlocker: true })}
			/>
		</div>
	)
}

function RotationContributors(props: { rotationId: ROT.RotationId; canManage: boolean }) {
	const contributorsRes = useQuery(RotationClient.getContributorsQuery(props.rotationId))
	const { rotationId } = props
	return (
		<ContributorsPopover
			contributors={contributorsRes.data}
			description={tr.text(ROT_Msgs.contributorsBlurb())}
			canManage={props.canManage}
			onAddUser={(user) => void RotationClient.Actions.addContributor(rotationId, { userId: user.discordId })}
			onAddRole={(role) => void RotationClient.Actions.addContributor(rotationId, { roleId: role.type })}
			onRemoveUser={(userId) => void RotationClient.Actions.removeContributor(rotationId, { userId })}
			onRemoveRole={(roleId) => void RotationClient.Actions.removeContributor(rotationId, { roleId })}
		>
			<Button variant="outline" size="sm">
				<Icons.Users />
				{tr.text(ROT_Msgs.contributors())}
			</Button>
		</ContributorsPopover>
	)
}

function LiveBar(props: { listHost: RotationEditorFrame.Key; host: LL.ListHost }) {
	const editorIds = Zus.useStore(
		UPClient.Store,
		Zus.useShallow((s) => [...UPClient.Sel.listEditorUserIds(props.host)(s)]),
	)
	const isModified = Zus.useStore(props.listHost, LayerQueuePrt.Sel.isModified)
	const names = editorIds.map((id) => PartsSys.findUser(id)?.displayName ?? String(id))
	return (
		<div role="status" className="flex flex-wrap items-center gap-3 rounded border bg-card px-3 py-1.5 text-sm">
			<span
				data-live={editorIds.length > 0}
				className="inline-flex items-center gap-1.5 font-semibold text-muted-foreground data-[live=true]:text-added"
			>
				<span className="h-2 w-2 rounded-full bg-current" />
				{editorIds.length > 0 ? tr.text(ROT_Msgs.liveEditors(names.join(', '))) : tr.text(ROT_Msgs.liveNobody())}
			</span>
			<span className="flex-1" />
			{isModified && <Badge variant="edited">{tr.text(ROT_Msgs.unsavedChanges())}</Badge>}
		</div>
	)
}

function RotationTagsRow(props: { rotation: ROT.Rotation; disabled: boolean }) {
	const { rotation } = props
	const setTags = (tags: string[]) => void RotationClient.Actions.updateMeta(rotation.id, { tags })
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className={cn(Typo.Label, 'min-w-32')}>{tr.text(ROT_Msgs.rotationTags())}</span>
			<LayerTags
				kind="rotation"
				tags={rotation.tags}
				disabled={props.disabled}
				onAdd={(tagId) => setTags([...rotation.tags, tagId])}
				onRemove={(tagId) => setTags(rotation.tags.filter((id) => id !== tagId))}
			/>
		</div>
	)
}

// opens a file dropped anywhere on the layers, as Open File... does
function ListSection(props: { listHost: RotationEditorFrame.Key; rotation: ROT.Rotation; children: React.ReactNode }) {
	const [, setIsEditing] = UPClient.useActivityState(UP.Trans.editingRotation(props.rotation.id))
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForRotation(props.rotation.id))
	const [dragging, setDragging] = React.useState(false)
	// dragenter and dragleave fire for every child the drag crosses, so the overlay shows while the count is above 0
	const dragDepth = React.useRef(0)
	const overlayZIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)
	const carriesFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
	// capture-phase handlers, so the text editor never inserts the file's text where it was dropped
	return (
		<section
			className="relative min-w-0 self-start rounded border bg-card [grid-area:layers]"
			aria-label={tr.text(ROT_Msgs.layers(props.rotation.items.length))}
			onDragEnter={(e) => {
				if (!carriesFiles(e) || writeDenied) return
				dragDepth.current++
				setDragging(true)
			}}
			onDragLeave={(e) => {
				if (!carriesFiles(e) || writeDenied) return
				dragDepth.current = Math.max(0, dragDepth.current - 1)
				if (dragDepth.current === 0) setDragging(false)
			}}
			onDragOverCapture={(e) => {
				if (!carriesFiles(e)) return
				e.preventDefault()
				e.stopPropagation()
				e.dataTransfer.dropEffect = writeDenied ? 'none' : 'copy'
			}}
			onDropCapture={(e) => {
				if (!carriesFiles(e)) return
				e.preventDefault()
				e.stopPropagation()
				dragDepth.current = 0
				setDragging(false)
				const file = e.dataTransfer.files[0]
				if (!file || writeDenied) return
				setIsEditing(true)
				void RotationEditorFrame.Actions.openFile(props.listHost, file)
			}}
		>
			{props.children}
			{dragging && (
				<div
					style={{ zIndex: overlayZIndex }}
					className="pointer-events-none absolute inset-0 flex items-center justify-center rounded border-2 border-dashed border-primary bg-background/80 p-4 text-center text-sm font-semibold"
				>
					{tr.text(ROT_Msgs.dropFileHint())}
				</div>
			)}
		</section>
	)
}

// where the items of an opened file go in a draft that already has items
function OpenedFileDialog(props: { listHost: RotationEditorFrame.Key }) {
	const file = Zus.useStore(props.listHost, (s) => s.openedFile)
	const place = (placement: LL.Placement) => () => void RotationEditorFrame.Actions.placeOpenedFile(props.listHost, placement)
	return (
		<Dialog
			open={file !== null}
			onOpenChange={(open) => {
				if (!open) RotationEditorFrame.Actions.dismissOpenedFile(props.listHost)
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{tr.text(ROT_Msgs.openedFileTitle(file?.name ?? ''))}</DialogTitle>
					<DialogDescription>{tr.text(ROT_Msgs.openedFileBlurb())}</DialogDescription>
				</DialogHeader>
				<DialogFooter className="flex-wrap gap-2">
					<Button variant="outline" onClick={() => RotationEditorFrame.Actions.dismissOpenedFile(props.listHost)}>
						{tr.text(UI_Msgs.cancel())}
					</Button>
					<Button variant="outline" onClick={place('start')}>
						{tr.text(LL_Msgs.placeStart())}
					</Button>
					<Button variant="outline" onClick={place('end')}>
						{tr.text(LL_Msgs.placeEnd())}
					</Button>
					<Button submitChord="manual" variant="primary" onClick={place('replace')}>
						{tr.text(LL_Msgs.placeReplace())}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function ListBody(props: { listHost: RotationEditorFrame.Key; rotationId: ROT.RotationId }) {
	const view = Zus.useStore(props.listHost, (s) => s.view)
	const [isEditing] = UPClient.useActivityState(UP.Trans.editingRotation(props.rotationId))
	if (view === 'builder') {
		return (
			<div className="p-1">
				<LayerList stores={{ listHost: props.listHost }} />
			</div>
		)
	}
	return (
		<React.Suspense fallback={<Spinner className="m-3 animate-spin" />}>
			<RotationSourceEditor listHost={props.listHost} editing={isEditing} />
		</React.Suspense>
	)
}

function ListToolbar(props: { listHost: RotationEditorFrame.Key; rotation: ROT.Rotation }) {
	const [, setIsEditing] = UPClient.useActivityState(UP.Trans.editingRotation(props.rotation.id))
	const [layerCount, isModified, fixingRepeats, view, problems] = Zus.useStore(
		props.listHost,
		Zus.useShallow(
			(s) =>
				[
					s.queue.layerList.length,
					s.queue.isModified,
					s.fixingRepeats,
					s.view,
					RotationEditorFrame.blockingProblems(s.source),
				] as const,
		),
	)
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForRotation(props.rotation.id))
	const queue = { queue: props.listHost }
	// each action starts editing first, as Add Layers does, so nobody has to press Start Editing before using one
	const editing = (action: () => void) => () => {
		setIsEditing(true)
		action()
	}
	const fileRef = React.useRef<HTMLInputElement>(null)
	const switchBlocked = problems > 0 ? tr.text(ROT_Msgs.switchViewBlocked(problems)) : false

	const clear = () => {
		const itemIds = Zus.getState(props.listHost).queue.layerList.map((item) => item.itemId)
		void LayerQueuePrt.Actions.dispatch(queue, { op: 'clear', itemIds })
	}

	return (
		<div className="flex flex-wrap items-center gap-1.5 border-b bg-panel px-2 py-1.5">
			<h3 className="text-base font-bold">{tr.text(ROT_Msgs.layers(layerCount))}</h3>
			<TabsList<RotationEditorFrame.View>
				variant="seg"
				className="ms-1.5"
				options={(
					[
						['builder', ROT_Msgs.viewBuilder()],
						['text', ROT_Msgs.viewText()],
						['yaml', ROT_Msgs.formatYaml()],
					] as const
				).map(([value, label]) => ({ value, label: tr.text(label), disabled: value !== view && switchBlocked }))}
				active={view}
				setActive={(next) => void RotationEditorFrame.Actions.setView(props.listHost, next)}
			/>
			<span className="flex-1" />
			{view === 'builder' && (
				<BuilderActions
					writeDenied={writeDenied}
					fixingRepeats={fixingRepeats}
					onFixRepeats={editing(() => void ListHostPrt.Actions.fixRepeats({ listHost: props.listHost }))}
					onClear={editing(clear)}
				/>
			)}
			<input
				ref={fileRef}
				type="file"
				accept=".yaml,.yml,.cfg,.txt,text/plain"
				className="hidden"
				onChange={(e) => {
					const file = e.target.files?.[0]
					e.target.value = ''
					if (file) void RotationEditorFrame.Actions.openFile(props.listHost, file)
				}}
			/>
			<PermissionDeniedTooltip denied={writeDenied}>
				<Button
					variant="outline"
					size="sm"
					title={tr.text(ROT_Msgs.openFileHint())}
					disabled={!!writeDenied}
					onClick={editing(() => fileRef.current?.click())}
				>
					<Icons.FolderOpen />
					{tr.text(ROT_Msgs.openFile())}
				</Button>
			</PermissionDeniedTooltip>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={tr.text(LL_Msgs.reset())}
				title={tr.text(LL_Msgs.reset())}
				disabled={!!writeDenied || !isModified}
				onClick={editing(() => void LayerQueuePrt.Actions.dispatch(queue, { op: 'reset-to-saved' }))}
			>
				<Icons.Undo className="rtl:-scale-x-100" />
			</Button>
			<CopyDownloadButtons listHost={props.listHost} view={view} />
		</div>
	)
}

function BuilderActions(props: {
	writeDenied: ReturnType<typeof RbacClient.usePermsCheck>
	fixingRepeats: boolean
	onFixRepeats: () => void
	onClear: () => void
}) {
	const { writeDenied } = props
	return (
		<>
			<StartActivityInteraction
				loaderName="selectLayers"
				createActivity={UP.createEditingQueueVariant({ code: 'ADDING_ITEM', cursor: { type: 'end' }, action: 'add' })}
				matchKey={(key) => key.code === 'ADDING_ITEM' && key.cursor.type === 'end' && !key.variant}
				preload="intent"
				render={Button}
				size="sm"
				disabled={!!writeDenied}
			>
				<Icons.ListPlus />
				{tr.text(LL_Msgs.addLayers())}
			</StartActivityInteraction>
			<StartActivityInteraction
				loaderName="genVote"
				createActivity={UP.createEditingQueueVariant({ code: 'GENERATING_VOTE', cursor: { type: 'end' } })}
				matchKey={(key) => key.code === 'GENERATING_VOTE'}
				preload="intent"
				render={Button}
				size="sm"
				disabled={!!writeDenied}
			>
				<Icons.Vote />
				{tr.text(LL_Msgs.genVote())}
			</StartActivityInteraction>
			<Tooltip help>
				<TooltipTrigger asChild>
					<Button size="sm" variant="outline" disabled={!!writeDenied || props.fixingRepeats} onClick={props.onFixRepeats}>
						{props.fixingRepeats ? <Spinner /> : <Icons.WandSparkles />}
						{tr.text(LL_Msgs.fixRepeats())}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{tr.text(LL_Msgs.fixRepeatsHint())}</TooltipContent>
			</Tooltip>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={tr.text(ROT_Msgs.clearLayers())}
				title={tr.text(ROT_Msgs.clearLayers())}
				disabled={!!writeDenied}
				onClick={props.onClear}
			>
				<Icons.Trash />
			</Button>
		</>
	)
}

// In the builder, Copy and Download each ask for a format. A text view copies and downloads the text it shows.
function CopyDownloadButtons(props: { listHost: RotationEditorFrame.Key; view: RotationEditorFrame.View }) {
	const { listHost, view } = props
	const label = tr.text(ROT_Msgs.copyAndDownload())
	if (view !== 'builder') {
		return (
			<ButtonGroup aria-label={label} className="ms-1.5">
				<Button variant="outline" size="sm" onClick={() => void RotationEditorFrame.Actions.copyText(listHost, view)}>
					<Icons.Copy />
					{tr.text(ROT_Msgs.copy())}
				</Button>
				<Button variant="outline" size="sm" onClick={() => void RotationEditorFrame.Actions.downloadText(listHost, view)}>
					<Icons.Download />
					{tr.text(ROT_Msgs.download())}
				</Button>
			</ButtonGroup>
		)
	}
	const option = (title: string, onSelect: () => void) => <DropdownMenuItem onSelect={onSelect}>{title}</DropdownMenuItem>
	return (
		<ButtonGroup aria-label={label} className="ms-1.5">
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="sm">
						<Icons.Copy />
						{tr.text(ROT_Msgs.copy())}
						<Icons.ChevronDown />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{option(tr.text(ROT_Msgs.copyAsText()), () => void RotationEditorFrame.Actions.copyText(listHost, 'text'))}
					{option(tr.text(ROT_Msgs.copyAsYaml()), () => void RotationEditorFrame.Actions.copyText(listHost, 'yaml'))}
				</DropdownMenuContent>
			</DropdownMenu>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="sm">
						<Icons.Download />
						{tr.text(ROT_Msgs.download())}
						<Icons.ChevronDown />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{option(tr.text(ROT_Msgs.downloadText()), () => void RotationEditorFrame.Actions.downloadText(listHost, 'text'))}
					{option(tr.text(ROT_Msgs.downloadYaml()), () => void RotationEditorFrame.Actions.downloadText(listHost, 'yaml'))}
				</DropdownMenuContent>
			</DropdownMenu>
		</ButtonGroup>
	)
}

// Start Editing, then Save or Finish Editing, the way the queue does it: the button reads Save when this is the only
// editor and there is something to save, and Force Save saves over the other editors.
function EditingControls(props: { listHost: RotationEditorFrame.Key; rotationId: ROT.RotationId }) {
	const host: LL.ListHost = { type: 'rotation', rotationId: props.rotationId }
	const [isEditing, setIsEditing] = UPClient.useActivityState(UP.Trans.editingRotation(props.rotationId))
	const [isModified, committing] = Zus.useStore(
		props.listHost,
		Zus.useShallow((s) => [s.queue.isModified, s.queue.committing] as const),
	)
	const editorCount = Zus.useStore(UPClient.Store, (s) => UPClient.Sel.listEditorUserIds(host)(s).size)
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForRotation(props.rotationId))
	const [forceSave, setForceSave] = React.useState(false)

	const finish = async () => {
		await RotationEditorFrame.Actions.flushSource(props.listHost)
		const solo = UPClient.Sel.listEditorUserIds(host)(Zus.getState(UPClient.Store)).size <= 1
		const modified = Zus.getState(props.listHost).queue.isModified
		setIsEditing(false)
		setForceSave(false)
		if (modified && (solo || forceSave)) {
			await LayerQueuePrt.Actions.dispatch({ queue: props.listHost }, { op: 'save', force: forceSave })
		}
	}

	if (committing) {
		return (
			<span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
				<Spinner className="animate-spin" />
				{tr.text(LL_Msgs.saving())}
			</span>
		)
	}
	if (!isEditing) {
		return (
			<PermissionDeniedTooltip denied={writeDenied}>
				<Button variant="primary" disabled={!!writeDenied} onClick={() => setIsEditing(true)}>
					<Icons.Pencil />
					{tr.text(ROT_Msgs.startEditing())}
				</Button>
			</PermissionDeniedTooltip>
		)
	}
	const label = forceSave ? UI_Msgs.forceSave() : editorCount <= 1 && isModified ? UI_Msgs.save() : UI_Msgs.finishEditing()
	const hint = forceSave ? ROT_Msgs.forceSaveHint() : isModified ? ROT_Msgs.saveHint() : ROT_Msgs.finishEditingHint()
	return (
		<ButtonGroup>
			<Tooltip help>
				<TooltipTrigger asChild>
					<Button
						variant={forceSave ? 'destructive' : 'default'}
						size="icon"
						aria-label={tr.text(ROT_Msgs.toggleForceSave())}
						aria-pressed={forceSave}
						onClick={() => setForceSave(!forceSave)}
					>
						<Icons.Sword />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{tr.text(ROT_Msgs.toggleForceSave())}</TooltipContent>
			</Tooltip>
			<Tooltip help>
				<TooltipTrigger asChild>
					<Button variant={forceSave ? 'destructive' : 'primary'} className="min-w-28" onClick={() => void finish()}>
						<Icons.Save />
						{tr.text(label)}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{tr.text(hint)}</TooltipContent>
			</Tooltip>
		</ButtonGroup>
	)
}

function EditFieldButton(props: { label: string; denied: ReturnType<typeof RbacClient.usePermsCheck>; onClick: () => void }) {
	return (
		<PermissionDeniedTooltip denied={props.denied}>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={props.label}
				title={props.label}
				disabled={!!props.denied}
				onClick={props.onClick}
			>
				<Icons.Pencil />
			</Button>
		</PermissionDeniedTooltip>
	)
}

// edits one of the rotation's name and description
function FieldDialog(props: { rotation: ROT.Rotation; field: 'name' | 'description'; onClose: () => void }) {
	const nameRef = React.useRef<HTMLInputElement>(null)
	const descriptionRef = React.useRef<HTMLTextAreaElement>(null)
	const id = React.useId()
	const submit = async (e: React.FormEvent) => {
		e.preventDefault()
		let patch: ROT.MetaPatch
		if (props.field === 'name') {
			const name = nameRef.current?.value.trim() ?? ''
			if (!ROT.NameSchema.safeParse(name).success) return
			patch = { name }
		} else {
			patch = { description: descriptionRef.current?.value.trim() || null }
		}
		if (await RotationClient.Actions.updateMeta(props.rotation.id, patch)) props.onClose()
	}
	return (
		<Dialog open onOpenChange={(open) => !open && props.onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={submit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{tr.text(props.field === 'name' ? ROT_Msgs.editName() : ROT_Msgs.editDescription())}</DialogTitle>
					</DialogHeader>
					{props.field === 'name' ? (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-name`}>{tr.text(ROT_Msgs.name())}</Label>
							<Input
								id={`${id}-name`}
								ref={nameRef}
								defaultValue={props.rotation.name}
								required
								minLength={3}
								maxLength={128}
								autoFocus
							/>
						</div>
					) : (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-description`}>{tr.text(ROT_Msgs.description())}</Label>
							<Textarea
								id={`${id}-description`}
								ref={descriptionRef}
								defaultValue={props.rotation.description ?? ''}
								maxLength={2048}
								rows={4}
								autoFocus
							/>
						</div>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={props.onClose}>
							{tr.text(UI_Msgs.cancel())}
						</Button>
						<Button submitChord="manual" type="submit" variant="primary">
							{tr.text(ROT_Msgs.saveDetails())}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
