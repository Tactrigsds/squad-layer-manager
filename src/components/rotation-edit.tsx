import * as Form from '@tanstack/react-form'
import { useQuery } from '@tanstack/react-query'
import { Link, useBlocker, useNavigate } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import { ContributorsPopover } from '@/components/contributors-popover'
import { EditDetailsButton, EditDetailsDialog, EditDetailsForm, FieldErrors, MarkdownHint } from '@/components/edit-details-dialog'
import { FullscreenSurface, FullscreenToggle } from '@/components/fullscreen'
import { LayerList } from '@/components/layer-list'
import { LayerTags } from '@/components/layer-tags'
import { MarkdownDescription } from '@/components/markdown-description'
import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { RepeatRulesetPanel } from '@/components/pool-config-panels'
import * as Typo from '@/components/typography'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import TabsList from '@/components/ui/tabs-list'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UndoRedoButtons } from '@/components/undo-redo-buttons'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as ListHostPrt from '@/frame-partials/list-host.partial'
import { useFrameLifecycle } from '@/frames/frame-manager'
import * as RepeatRulesetEditorFrame from '@/frames/repeat-ruleset-editor.frame'
import * as RotationEditorFrame from '@/frames/rotation-editor.frame'
import * as Rx from '@/lib/rxjs'
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
import * as KBClient from '@/systems/keybinds.client'
import * as LLDnd from '@/systems/layer-list-dnd.client'
import { tr } from '@/systems/messages.client'
import * as PartsSys from '@/systems/parts.client'
import * as RbacClient from '@/systems/rbac.client'
import * as RotationClient from '@/systems/rotation.client'
import * as UPClient from '@/systems/user-presence.client'

import { StartActivityInteraction } from './activity'
import { CloneRotationDialog, DeleteRotationDialog } from './rotation-dialogs'

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
	const host = RotationEditorFrame.listHostFor(rotation.id)
	const repeatRulesetEditorInput = React.useMemo(
		() => RepeatRulesetEditorFrame.createInput({ type: 'rotation', rotationId: rotation.id }),
		[rotation.id],
	)
	const repeatRulesetEditor = useFrameLifecycle(RepeatRulesetEditorFrame.frame, { input: repeatRulesetEditorInput })
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForRotation(rotation.id))
	const manageDenied = RbacClient.usePermsCheck(RBAC.getManagePermReqForRotation(rotation.id))
	const createDenied = RbacClient.usePermsCheck(RBAC.perm('rotations:create'))
	const [dialog, setDialog] = React.useState<'details' | 'clone' | 'delete' | null>(null)

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
	const singleColumn = Zus.useStore(listHost, (s) => s.view) === 'yaml'

	return (
		<div className="container mx-auto py-4 px-4 space-y-4">
			<Link to="/rotations" className="text-sm text-muted-foreground hover:underline">
				‹ {tr.text(ROT_Msgs.pageTitle())}
			</Link>
			<header className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="flex min-w-0 items-center gap-x-4">
						<h3 className={cn(Typo.H3, 'min-w-0 truncate')}>{rotation.name}</h3>
						<Icons.Dot className="shrink-0" />
						<small className="font-light">{tr.text(ROT_Msgs.ownerLabel(ownerName ?? ''))}</small>
						<Icons.Dot className="shrink-0" />
						<EditDetailsButton denied={writeDenied} onClick={() => setDialog('details')} />
					</span>
					<span className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-xs text-muted-foreground">{rotation.id}</span>
						{rotation.archived && <Badge variant="secondary">{tr.text(ROT_Msgs.archivedBadge())}</Badge>}
						<RotationContributors rotationId={rotation.id} canManage={!manageDenied} />
					</span>
				</div>
				<Separator orientation="horizontal" />
				<MarkdownDescription description={rotation.description} />
			</header>

			<LiveBar listHost={listHost} host={host} />

			<RotationTagsRow
				tags={rotation.tags}
				disabled={!!writeDenied}
				onChange={(tags) => void RotationClient.Actions.updateMeta(rotation.id, { tags })}
			/>

			{/* one column puts the actions above the layers and the repeat ruleset below them. Two columns put both beside
			    the layers. YAML keeps one column at any width, since its editor shares its width with an errors column. */}
			<div className="@container">
				<div
					className={cn(
						"grid gap-4 [grid-template-areas:'actions'_'layers'_'ruleset']",
						!singleColumn &&
							"@[960px]:grid-cols-[minmax(0,1fr)_fit-content(40%)] @[960px]:grid-rows-[auto_1fr] @[960px]:[grid-template-areas:'layers_actions'_'layers_ruleset']",
					)}
				>
					<ListSection listHost={listHost} host={host}>
						<ListToolbar listHost={listHost} host={host} />
						<ListBody listHost={listHost} host={host} />
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

			<EditDetailsDialog open={dialog === 'details'} onOpenChange={(open) => setDialog(open ? 'details' : null)}>
				<RotationDetailsForm
					initial={{ id: rotation.id, name: rotation.name, description: rotation.description }}
					creating={false}
					submitLabel={tr.text(UI_Msgs.save())}
					onSubmit={(values) => RotationClient.Actions.updateMeta(rotation.id, { name: values.name, description: values.description })}
					onClose={() => setDialog(null)}
				/>
			</EditDetailsDialog>
			<CloneRotationDialog source={rotation} open={dialog === 'clone'} onOpenChange={(open) => setDialog(open ? 'clone' : null)} />
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
			<Button variant="outline">
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
		<div
			role="status"
			aria-label={tr.text(ROT_Msgs.liveStatus())}
			className="flex flex-wrap items-center gap-3 rounded border bg-card px-3 py-1.5 text-sm"
		>
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

function RotationTagsRow(props: { tags: string[]; disabled: boolean; onChange: (tags: string[]) => void }) {
	const { tags } = props
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className={cn(Typo.Label, 'min-w-32')}>{tr.text(ROT_Msgs.rotationTags())}</span>
			<LayerTags
				kind="rotation"
				tags={tags}
				disabled={props.disabled}
				onAdd={(tagId) => props.onChange([...tags, tagId])}
				onRemove={(tagId) => props.onChange(tags.filter((id) => id !== tagId))}
			/>
		</div>
	)
}

// opens a file dropped anywhere on the layers, as Open File... does
function ListSection(props: { listHost: RotationEditorFrame.Key; host: LL.ListHost; children: React.ReactNode }) {
	const [, setIsEditing] = UPClient.useActivityState(UP.Trans.editingList(props.host))
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForList(props.host))
	const layerCount = Zus.useStore(props.listHost, (s) => s.queue.layerList.length)
	const [dragging, setDragging] = React.useState(false)
	// dragenter and dragleave fire for every child the drag crosses, so the overlay shows while the count is above 0
	const dragDepth = React.useRef(0)
	const overlayZIndex = useZIndex(ZI_OFFSETS.MINOR_CEILING)
	const carriesFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files')
	const kbScope = KBClient.useScope('rotation-editor', {})
	const fullscreen = Zus.useStore(props.listHost, (s) => s.fullscreen)
	// capture-phase handlers, so the text editor never inserts the file's text where it was dropped
	return (
		<KBClient.Context.Provider value={kbScope.id}>
			<FullscreenSurface
				fullscreen={fullscreen}
				onExit={() => RotationEditorFrame.Actions.setFullscreen(props.listHost, false)}
				className="flex min-w-0 flex-col self-start [grid-area:layers]"
			>
				<section
					ref={kbScope.ref}
					className="relative flex min-h-0 flex-1 flex-col rounded border bg-card"
					{...{ [LLDnd.BOUNDS_ATTR]: '' }}
					aria-label={tr.text(ROT_Msgs.layers(layerCount))}
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
			</FullscreenSurface>
		</KBClient.Context.Provider>
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

function ListBody(props: { listHost: RotationEditorFrame.Key; host: LL.ListHost }) {
	const view = Zus.useStore(props.listHost, (s) => s.view)
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForList(props.host))
	if (view === 'builder') {
		return (
			<div className="p-1">
				<LayerList stores={{ listHost: props.listHost }} />
			</div>
		)
	}
	return (
		<React.Suspense fallback={<Spinner className="m-3 animate-spin" />}>
			<RotationSourceEditor listHost={props.listHost} writable={!writeDenied} />
		</React.Suspense>
	)
}

function ListToolbar(props: { listHost: RotationEditorFrame.Key; host: LL.ListHost }) {
	const [, setIsEditing] = UPClient.useActivityState(UP.Trans.editingList(props.host))
	const [layerCount, isModified, fixingRepeats, view, fullscreen, problems] = Zus.useStore(
		props.listHost,
		Zus.useShallow(
			(s) =>
				[
					s.queue.layerList.length,
					s.queue.isModified,
					s.fixingRepeats,
					s.view,
					s.fullscreen,
					RotationEditorFrame.blockingProblems(s.source),
				] as const,
		),
	)
	const writeDenied = RbacClient.usePermsCheck(RBAC.getWritePermReqForList(props.host))
	const [undoKind, redoKind] = Zus.useStore(
		props.listHost,
		Zus.useShallow((s) => [LayerQueuePrt.Sel.undoEntry(s)?.kind ?? null, LayerQueuePrt.Sel.redoEntry(s)?.kind ?? null] as const),
	)
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
		void LayerQueuePrt.Actions.dispatch(queue, { op: 'clear', itemIds }, { undoToast: true })
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
			<UndoRedoButtons
				disabled={!!writeDenied}
				undo={{
					description: undoKind && tr.text(LL_Msgs.undoTooltip('undo', undoKind)),
					onClick: editing(() => LayerQueuePrt.Actions.undo(queue)),
				}}
				redo={{
					description: redoKind && tr.text(LL_Msgs.undoTooltip('redo', redoKind)),
					onClick: editing(() => LayerQueuePrt.Actions.redo(queue)),
				}}
			/>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={tr.text(LL_Msgs.reset())}
				title={tr.text(LL_Msgs.reset())}
				disabled={!!writeDenied || !isModified}
				onClick={editing(() => void LayerQueuePrt.Actions.dispatch(queue, { op: 'reset-to-saved' }, { undoToast: true }))}
			>
				<Icons.RotateCcw className="rtl:-scale-x-100" />
			</Button>
			{view !== 'builder' && (
				<FullscreenToggle
					fullscreen={fullscreen}
					onToggle={() => RotationEditorFrame.Actions.setFullscreen(props.listHost, !fullscreen)}
				/>
			)}
			<FileButtons listHost={props.listHost} view={view} openDenied={writeDenied} onOpenFile={editing(() => fileRef.current?.click())} />
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

// The builder keeps these in a menu, where Copy and Download each come in both formats. A text view shows them as
// buttons, which copy and download the text it shows.
function FileButtons(props: {
	listHost: RotationEditorFrame.Key
	view: RotationEditorFrame.View
	openDenied: ReturnType<typeof RbacClient.usePermsCheck>
	onOpenFile: () => void
}) {
	const { listHost, view } = props
	const label = tr.text(ROT_Msgs.fileActions())
	if (view !== 'builder') {
		return (
			<ButtonGroup aria-label={label} className="ms-1.5">
				<PermissionDeniedTooltip denied={props.openDenied}>
					<Button
						variant="outline"
						size="sm"
						title={tr.text(ROT_Msgs.openFileHint())}
						disabled={!!props.openDenied}
						onClick={props.onOpenFile}
					>
						<Icons.FolderOpen />
						{tr.text(ROT_Msgs.openFile())}
					</Button>
				</PermissionDeniedTooltip>
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
	return (
		<DropdownMenu modal={false}>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon-sm" aria-label={label}>
							<Icons.Ellipsis />
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end">
				<DropdownMenuItem disabled={!!props.openDenied} title={tr.text(ROT_Msgs.openFileHint())} onSelect={props.onOpenFile}>
					<Icons.FolderOpen />
					{tr.text(ROT_Msgs.openFile())}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => void RotationEditorFrame.Actions.copyText(listHost, 'text')}>
					<Icons.Copy />
					{tr.text(ROT_Msgs.copyAsText())}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => void RotationEditorFrame.Actions.copyText(listHost, 'yaml')}>
					<Icons.Copy />
					{tr.text(ROT_Msgs.copyAsYaml())}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => void RotationEditorFrame.Actions.downloadText(listHost, 'text')}>
					<Icons.Download />
					{tr.text(ROT_Msgs.downloadText())}
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => void RotationEditorFrame.Actions.downloadText(listHost, 'yaml')}>
					<Icons.Download />
					{tr.text(ROT_Msgs.downloadYaml())}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
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
	const problems = Zus.useStore(props.listHost, RotationEditorFrame.Sel.blockingProblemCount)
	const [forceSave, setForceSave] = React.useState(false)

	// finishing with problems in the text would drop what the text says, so neither Save nor Finish Editing goes through
	const finish = async () => {
		await RotationEditorFrame.Actions.flushSource(props.listHost)
		if (RotationEditorFrame.Sel.blockingProblemCount(Zus.getState(props.listHost)) > 0) return
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
					<Button
						variant={forceSave ? 'destructive' : 'primary'}
						className="min-w-28"
						aria-disabled={problems > 0 || undefined}
						data-softdisabled={problems > 0}
						onClick={() => void finish()}
					>
						<Icons.Save />
						{tr.text(label)}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{tr.text(problems > 0 ? ROT_Msgs.saveBlocked(problems) : hint)}</TooltipContent>
			</Tooltip>
		</ButtonGroup>
	)
}

type DetailsValues = { id: string; name: string; description: string | null }

// The fields of a rotation's Edit Details dialog. A rotation that has not been created yet also takes its ID here,
// which follows the name until it is edited by hand. onSubmit resolves to whether the dialog may close.
function RotationDetailsForm(props: {
	initial: DetailsValues
	creating: boolean
	submitLabel: string
	onSubmit: (values: DetailsValues) => Promise<boolean> | boolean
	onClose: () => void
}) {
	const form = Form.useForm({
		defaultValues: props.initial,
		onSubmit: async ({ value }) => {
			const values = { id: value.id, name: value.name.trim(), description: value.description?.trim() || null }
			if (await props.onSubmit(values)) props.onClose()
		},
	})
	const idRef = React.useRef<HTMLInputElement>(null)
	const onNameChange = (name: string, setName: (name: string) => void) => {
		const id = form.getFieldValue('id')
		if (props.creating && idRef.current && (id === '' || id === ROT.idFromName(form.getFieldValue('name')))) {
			idRef.current.value = ROT.idFromName(name)
			form.setFieldValue('id', idRef.current.value)
		}
		setName(name)
	}
	return (
		<form.Subscribe selector={(v) => [v.canSubmit, v.isDirty, v.isSubmitting] as const}>
			{([canSubmit, isDirty, isSubmitting]) => (
				<EditDetailsForm
					onSubmit={() => void form.handleSubmit()}
					onCancel={props.onClose}
					submitLabel={props.submitLabel}
					submitDisabled={!canSubmit || !isDirty || isSubmitting}
					className="flex flex-col gap-4"
				>
					<form.Field name="name" validators={{ onChange: ROT.NameSchema }}>
						{(field) => {
							const label = tr.text(ROT_Msgs.name())
							return (
								<div className="flex flex-col space-y-2">
									<Label htmlFor={field.name}>{label}</Label>
									<Input
										id={field.name}
										placeholder={label}
										defaultValue={field.state.value}
										autoFocus
										onBlur={field.handleBlur}
										onChange={(e) => onNameChange(e.target.value, field.handleChange)}
									/>
									<FieldErrors label={label} errors={field.state.meta.errors} />
								</div>
							)
						}}
					</form.Field>
					{props.creating && (
						<form.Field name="id" validators={{ onChange: ROT.NewRotationIdSchema }}>
							{(field) => {
								const label = tr.text(ROT_Msgs.id())
								return (
									<div className="flex flex-col space-y-2">
										<Label htmlFor={field.name}>{label}</Label>
										<p id={`${field.name}-hint`} className="text-xs text-muted-foreground">
											{tr.text(ROT_Msgs.idHelp())}
										</p>
										<Input
											id={field.name}
											aria-describedby={`${field.name}-hint`}
											ref={idRef}
											placeholder={label}
											defaultValue={field.state.value}
											className="font-mono"
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value.trim())}
										/>
										<FieldErrors label={label} errors={field.state.meta.errors} />
									</div>
								)
							}}
						</form.Field>
					)}
					<form.Field name="description" validators={{ onChange: ROT.DescriptionSchema.nullable() }}>
						{(field) => {
							const label = tr.text(ROT_Msgs.description())
							return (
								<div className="flex flex-col space-y-2">
									<Label htmlFor={field.name}>{label}</Label>
									<MarkdownHint id={`${field.name}-hint`} />
									<Textarea
										id={field.name}
										aria-describedby={`${field.name}-hint`}
										placeholder={label}
										defaultValue={field.state.value ?? ''}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value.trim() || null)}
										rows={12}
										className="font-mono text-sm"
									/>
									<FieldErrors label={label} errors={field.state.meta.errors} />
								</div>
							)
						}}
					</form.Field>
				</EditDetailsForm>
			)}
		</form.Subscribe>
	)
}

// The page of a rotation that has not been created yet. Its details dialog opens with the page, and can be closed to
// edit the layers first. Create opens it again while the name or the ID is missing.
export function RotationNew(props: { listHost: RotationEditorFrame.Key }) {
	const { listHost } = props
	const host = RotationEditorFrame.listHostFor(null)
	const navigate = useNavigate()
	const [detailsOpen, setDetailsOpen] = React.useState(true)
	const [creating, setCreating] = React.useState(false)
	const details = Zus.useStore(listHost, RotationEditorFrame.Sel.newDetails)
	const layerCount = Zus.useStore(listHost, (s) => s.queue.layerList.length)
	const singleColumn = Zus.useStore(listHost, (s) => s.view) === 'yaml'
	const createDenied = RbacClient.usePermsCheck(RBAC.perm('rotations:create'))
	const repeatRulesetEditorInput = React.useMemo(
		() =>
			RepeatRulesetEditorFrame.createInput({
				type: 'pool-draft',
				value$: Zus.toObservable(listHost, true).pipe(Rx.map(([s]) => s.newDetails ?? undefined)),
			}),
		[listHost],
	)
	const repeatRulesetEditor = useFrameLifecycle(RepeatRulesetEditorFrame.frame, { input: repeatRulesetEditorInput })

	// leaving loses the new rotation, so it asks first once there is something to lose
	const unsaved = layerCount > 0 || details.name !== '' || details.description !== null
	useBlocker({
		enableBeforeUnload: unsaved,
		shouldBlockFn: () => unsaved && !confirm(tr.text(ROT_Msgs.unsavedChangesConfirm())),
	})

	const create = async () => {
		if (!RotationEditorFrame.newDetailsComplete(details)) {
			setDetailsOpen(true)
			return
		}
		setCreating(true)
		try {
			if (await RotationEditorFrame.Actions.create(listHost)) {
				void navigate({ to: '/rotations/$rotationId', params: { rotationId: details.id }, ignoreBlocker: true })
			}
		} finally {
			setCreating(false)
		}
	}

	return (
		<div className="container mx-auto py-4 px-4 space-y-4">
			<Link to="/rotations" className="text-sm text-muted-foreground hover:underline">
				‹ {tr.text(ROT_Msgs.pageTitle())}
			</Link>
			<header className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="flex min-w-0 items-center gap-x-4">
						<h3 className={cn(Typo.H3, 'min-w-0 truncate', !details.name && 'text-muted-foreground')}>
							{details.name || tr.text(ROT_Msgs.newRotation())}
						</h3>
						<Icons.Dot className="shrink-0" />
						<EditDetailsButton denied={createDenied} onClick={() => setDetailsOpen(true)} />
					</span>
					{details.id && <span className="font-mono text-xs text-muted-foreground">{details.id}</span>}
				</div>
				<Separator orientation="horizontal" />
				<MarkdownDescription description={details.description} />
			</header>

			<RotationTagsRow
				tags={details.tags}
				disabled={!!createDenied}
				onChange={(tags) => RotationEditorFrame.Actions.setNewDetails(listHost, { tags })}
			/>

			<div className="@container">
				<div
					className={cn(
						"grid gap-4 [grid-template-areas:'actions'_'layers'_'ruleset']",
						!singleColumn &&
							"@[960px]:grid-cols-[minmax(0,1fr)_fit-content(40%)] @[960px]:grid-rows-[auto_1fr] @[960px]:[grid-template-areas:'layers_actions'_'layers_ruleset']",
					)}
				>
					<ListSection listHost={listHost} host={host}>
						<ListToolbar listHost={listHost} host={host} />
						<ListBody listHost={listHost} host={host} />
					</ListSection>
					<OpenedFileDialog listHost={listHost} />

					<div className="flex flex-wrap content-start gap-1.5 [grid-area:actions]">
						<PermissionDeniedTooltip denied={createDenied}>
							<Button variant="primary" disabled={!!createDenied || creating} onClick={() => void create()}>
								<Icons.Save />
								{tr.text(ROT_Msgs.create())}
							</Button>
						</PermissionDeniedTooltip>
					</div>
					<section className="min-w-0 self-start rounded border bg-card p-3 [grid-area:ruleset]">
						<RepeatRulesetPanel
							title={tr.text(ROT_Msgs.repeatRuleset())}
							help={tr.text(ROT_Msgs.repeatRulesetHelp())}
							repeatRulesetId={details.repeatRulesetId}
							selectDisabled={!!createDenied}
							onSelect={(repeatRulesetId) => RotationEditorFrame.Actions.setNewDetails(listHost, { repeatRulesetId })}
							repeatRulesetEditor={repeatRulesetEditor}
							inlineSave
							rulesInDialog
						/>
					</section>
				</div>
			</div>

			<EditDetailsDialog
				open={detailsOpen}
				onOpenChange={setDetailsOpen}
				title={tr.text(ROT_Msgs.newRotation())}
				description={tr.text(ROT_Msgs.newDetailsDialogBlurb())}
			>
				<RotationDetailsForm
					initial={{ id: details.id, name: details.name, description: details.description }}
					creating
					submitLabel={tr.text(UI_Msgs.apply())}
					onSubmit={(values) => {
						RotationEditorFrame.Actions.setNewDetails(listHost, values)
						return true
					}}
					onClose={() => setDetailsOpen(false)}
				/>
			</EditDetailsDialog>
		</div>
	)
}
