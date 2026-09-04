import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

import { PermissionDeniedTooltip } from '@/components/permission-denied-tooltip'
import { PluginsSection } from '@/components/plugins-section'
import type SchemaYamlEditorComponent from '@/components/schema-yaml-editor'
import type { SchemaYamlEditorHandle } from '@/components/schema-yaml-editor.types'
import { useOpenServerConsoleWindow } from '@/components/server-console-window.helpers'
import SettingsForm from '@/components/settings-form'
import { SettingsChangeList, SettingsSavePanel } from '@/components/settings-save-panel'
import SettingsToc from '@/components/settings-toc'
import { StateBoundary } from '@/components/state-boundary'
import { StickyGroup } from '@/components/sticky-group'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import { Spinner } from '@/components/ui/spinner'
import { frameManager } from '@/frames/frame-manager'
import * as SettingsEditorFrame from '@/frames/settings-editor.frame'
import { useForwardWheelToScroller } from '@/lib/browser'
import { createId } from '@/lib/id'
import { useRefConstructor } from '@/lib/react'
import * as ReactRx from '@/lib/react-rxjs'
import {
	ADVANCED_GLOBAL_SETTINGS_PATHS,
	ADVANCED_SERVER_SETTINGS_PATHS,
	GLOBAL_SETTINGS_GROUPS,
	SERVER_SETTINGS_PRIORITY_KEYS,
} from '@/lib/settings-groups'
import * as SettingsNav from '@/lib/settings-nav'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as AppEvents_Msgs from '@/messages/app-events.messages'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import type * as AppEvents from '@/models/app-events.models'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UsersClient from '@/systems/users.client'

// registers the server-console window definition, which lives in the window module rather than its helpers
void import('@/components/server-console-window')

// stable empty-servers reference while public settings haven't loaded, keeping the readable-servers memo stable
const NO_SERVERS: never[] = []

// lazily loaded so the CodeMirror editor bundle isn't paid for until an editor is actually shown.
// the `as` casts restore the generic component signature that React.lazy erases.
const SchemaYamlEditor = React.lazy(
	() => import('@/components/schema-yaml-editor') as unknown as Promise<{ default: React.FC<any> }>,
) as unknown as typeof SchemaYamlEditorComponent

export const Route = createFileRoute('/_app/settings')({
	head: () => ({
		meta: [{ title: tr.text(SETTINGS_Msgs.pageTitle()) }],
	}),

	component: RouteComponent,
})

function RouteComponent() {
	const manageServersDenied = RbacClient.usePermsCheck(RBAC.perm('admin:manage-servers'))
	const managePluginsDenied = RbacClient.usePermsCheck(RBAC.perm('plugins:manage'))
	const globalAccess = RbacClient.useGlobalSettingsAccess()
	const loggedInPerms = RbacClient.useSuspendableLoggedInUserPerms()
	// creating a server requires supplying its connection details, so it needs write-sensitive in addition to manage-servers
	const canCreateServers = React.useMemo(() => RBAC.canCreateServers(loggedInPerms), [loggedInPerms])
	// scopes this visit's frame instances: a fresh pageId per mount means fresh drafts + a fresh raw-settings fetch
	const [pageId] = React.useState(() => createId(4))
	// non-null while the new-server form is open; a fresh nonce per "Add Managed Server" click yields a clean frame instance
	const [creatingNonce, setCreatingNonce] = React.useState<string | null>(null)

	// a server section renders for every server the user may at least read; registry management is gated separately
	// managing plugins is grant enough on its own; global read otherwise carries the list as a read-only view
	const canSeePlugins = globalAccess.canRead || !managePluginsDenied
	const allServers = Zus.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers) ?? NO_SERVERS
	const servers = React.useMemo(
		() => allServers.filter((s) => RBAC.canReadServerSettings(loggedInPerms, s.id, RBAC.NO_SCOPED_SERVERS)),
		[allServers, loggedInPerms],
	)

	// one settings-editor frame instance per section; ensureSetup is an idempotent cache-ensure, so calling it while
	// deriving render data is fine (same as the squad-server frame in route.tsx / nav-bar)
	const sectionKeys = React.useMemo(() => {
		const keys: SettingsEditorFrame.Key[] = []
		for (const s of servers) {
			keys.push(frameManager.ensureSetup(SettingsEditorFrame.frame, { kind: 'server', serverId: s.id, pageId }))
		}
		if (!manageServersDenied && canCreateServers && creatingNonce !== null) {
			keys.push(frameManager.ensureSetup(SettingsEditorFrame.frame, { kind: 'new-server', nonce: creatingNonce, pageId }))
		}
		if (globalAccess.canRead) {
			keys.push(frameManager.ensureSetup(SettingsEditorFrame.frame, { kind: 'global', pageId }))
		}
		return keys
	}, [servers, creatingNonce, globalAccess.canRead, manageServersDenied, canCreateServers, pageId])

	// frame instances are otherwise reclaimed only when the FinalizationRegistry gets around to it, which can leave
	// the global watch subscription and per-section drafts alive long after leaving the page (and every visit mints
	// fresh instances via pageId). Tear down everything this visit accumulated when the page unmounts. The teardown is
	// deferred to an idle callback and cancelled on re-setup so StrictMode's simulated remount doesn't kill instances
	// the still-mounted page references.
	const teardownCtlRef = useRefConstructor(() => ({ keys: new Set<SettingsEditorFrame.Key>(), pending: null as number | null }))
	React.useEffect(() => {
		const teardownCtl = teardownCtlRef.current
		if (teardownCtl.pending !== null) {
			cancelIdleCallback(teardownCtl.pending)
			teardownCtl.pending = null
		}
		for (const k of sectionKeys) teardownCtl.keys.add(k)
		return () => {
			teardownCtl.pending = requestIdleCallback(() => {
				teardownCtl.pending = null
				for (const k of teardownCtl.keys) frameManager.dropKey(k)
				teardownCtl.keys.clear()
			})
		}
	}, [sectionKeys, teardownCtlRef])

	const sectionStates = SettingsEditorFrame.useSectionStates(sectionKeys)
	const { newServerCreated, anyDirty } = Zus.useStore(...sectionKeys, SettingsEditorFrame.Sel.pageStatus)
	const creating = creatingNonce !== null && !newServerCreated

	// block in-app navigation and tab close while any section holds unsaved edits (same pattern as filter-edit)
	useBlocker({
		enableBeforeUnload: anyDirty,
		shouldBlockFn: () => {
			const dirty = sectionKeys.some((k) => {
				const s = frameManager.getState(k)
				return !!s && SettingsEditorFrame.Sel.dirty(s)
			})
			if (!dirty) return false
			const shouldLeave = confirm(tr.text(SETTINGS_Msgs.unsavedChanges()))
			return !shouldLeave
		},
	})

	const rootRef = React.useRef<HTMLDivElement>(null)
	const mainRef = React.useRef<HTMLElement>(null)
	// the margins either side of the centred columns, and the empty space below a short table of contents, sit outside
	// `main`, so without this their wheel events land on nothing
	useForwardWheelToScroller(rootRef, mainRef, null)

	// the fragment to scroll to on load, captured once. Handled lazily below once its owning section has rendered, since
	// the sections load async (per-server fetch, global-settings Suspense) and a `setting:*` field only exists after its
	// section mounts.
	const initialAnchorRef = useRefConstructor(() => ({ id: SettingsNav.currentAnchor(), handled: false }))

	// initial page-load fragment: gate on the owning section actually being in the DOM (re-checked as sections stream in
	// via sectionStates), then hand off to the exact same navigateToAnchor path a TOC click uses. `handled` latches so
	// later sectionStates changes (form edits) don't re-trigger it; the settle loop self-terminates on unmount.
	React.useEffect(() => {
		if (initialAnchorRef.current.handled || !initialAnchorRef.current.id) return
		const id = initialAnchorRef.current.id
		const section = SettingsNav.sectionForAnchor(id)
		// wait until the owning section has rendered; an unrecognized anchor (section === null) is handled immediately
		if (section && !document.getElementById(section)) return
		initialAnchorRef.current.handled = true
		SettingsNav.navigateToAnchor(id)
	}, [sectionStates, initialAnchorRef])

	// later hash changes from a pasted/edited link (in-app clicks use replaceState, which fires no hashchange, so no
	// double-scroll) route through the same path
	React.useEffect(() => {
		const onHash = () => {
			const id = SettingsNav.currentAnchor()
			if (id) SettingsNav.navigateToAnchor(id)
		}
		window.addEventListener('hashchange', onHash)
		return () => window.removeEventListener('hashchange', onHash)
	}, [])

	// when the user clicks "Add Managed Server", scroll the new-server config into view once it mounts (the section renders on
	// the next frame). Existing servers scroll via the pencil/Fix buttons in the management card.
	React.useEffect(() => {
		if (!creating) return
		return SettingsNav.scrollToAnchorSettled('section:server:__new__', { deadlineMs: 1500 })
	}, [creating])

	if (manageServersDenied && !globalAccess.canRead && servers.length === 0 && !canSeePlugins) {
		return (
			<div className="w-full h-full grid place-items-center">
				<p className="text-muted-foreground">{tr.text(SETTINGS_Msgs.noAccess())}</p>
			</div>
		)
	}

	return (
		// Bounded to the viewport (navbar h-16 + outlet p-4 = 6rem) so the two columns can scroll independently; the
		// outlet wrapper is overflow-hidden, which would otherwise break sticky/independent scrolling.
		// This element stays full width while the columns centre inside it, so the centring margins belong to it and
		// useForwardWheelToScroller can hand their wheel events to `main` -- they'd otherwise land on the outlet
		// wrapper, which doesn't scroll.
		<div ref={rootRef} className="flex w-full h-[calc(100dvh-6rem)] justify-center">
			<div className="flex h-full w-full max-w-6xl">
				{/* Sized like the commands page's. The columns are capped and centred now, so growing the TOC with the viewport
				    would only eat the content column, which needs the width more -- its server sections are master-detail. */}
				<aside className="w-52 md:w-56 shrink-0 overflow-hidden border-r border-line pr-2 shadow-[1px_0_0_var(--line-soft)]">
					<SettingsToc
						showServers={!manageServersDenied || servers.length > 0}
						showGlobal={globalAccess.canRead}
						showPlugins={canSeePlugins}
						canManagePlugins={!managePluginsDenied}
						servers={servers}
						sectionKeys={sectionKeys}
					/>
				</aside>
				{/* `main` spans the whole non-TOC width of the centred group (the content column is centred inside it in turn),
			    so a wheel between the two still scrolls the settings; the margins outside the group are the hook's job.
			    `relative` is load-bearing: sr-only elements in the form are position:absolute, and without a positioned
			    scroll container they escape main's clipping and stretch the document's scroll height to the full unclipped
			    content height, making the whole app (navbar included) scroll away. */}
				<main ref={mainRef} className="relative flex-1 min-w-0 overflow-y-auto">
					{/* no top padding: sticky section headers pin flush to the top, otherwise scrolled content bleeds into the gap */}
					<div className="mx-auto w-full max-w-[68rem] px-3 pb-2 space-y-4">
						{/* Servers reads PublicSettingsStore, not globalSettings$, so it must not sit behind the global-settings Suspense */}
						{(!manageServersDenied || servers.length > 0) && (
							<div id="section:servers" className="scroll-mt-2 rounded-xl">
								<ServersSection
									servers={servers}
									sectionKeys={sectionKeys}
									canManage={!manageServersDenied}
									canCreate={canCreateServers}
									creating={creating}
									onAddServer={() => setCreatingNonce(createId(4))}
									onCancelCreate={() => setCreatingNonce(null)}
								/>
							</div>
						)}
						{canSeePlugins && (
							<div id="section:plugins" className="scroll-mt-2 rounded-xl">
								<PluginsSection canManage={!managePluginsDenied} />
							</div>
						)}
						{globalAccess.canRead &&
							(() => {
								const key = sectionKeys.find((k) => k.kind === 'global')
								if (!key) return null
								// Subscribe has no fallback of its own: the suspension is handed to StateBoundary, which also
								// catches the first-emit timeout if global settings never arrive
								return (
									<StateBoundary subject="global-settings">
										<ReactRx.Subscribe source$={SettingsClient.globalSettings$}>
											<div id="section:global" className="scroll-mt-2 rounded-xl">
												<GlobalSettingsSection stores={{ settingsEditor: key }} />
											</div>
											<div id="section:audit" className="scroll-mt-2 rounded-xl">
												<AuditLogSection />
											</div>
										</ReactRx.Subscribe>
									</StateBoundary>
								)
							})()}
					</div>
				</main>
			</div>
			<SettingsSavePanel sectionKeys={sectionKeys} onDiscardNewServer={() => setCreatingNonce(null)} />
		</div>
	)
}

function AuditLogSection() {
	const { data } = useQuery(RPC.orpc.appEvents.list.queryOptions({ input: { limit: 100 } }))
	const events: AppEvents.AppEvent[] = data?.code === 'ok' ? data.events : []
	const userIds = [...new Set(events.flatMap((e) => (e.actor.type === 'slm-user' ? [e.actor.userId] : [])))]
	const usersRes = UsersClient.useUsers(userIds, { enabled: userIds.length > 0 })
	const userMap = new Map((usersRes.data?.code === 'ok' ? usersRes.data.users : []).map((u) => [u.discordId, u]))

	// resolved server-side from the players table, since the audit log has no roster to look anyone up in
	const playerNames: Record<string, string> = data?.code === 'ok' ? data.playerNames : {}
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)
	const playerName = (id: string) => playerNames[id]

	function actorName(actor: AppEvents.Actor): string {
		if (actor.type === 'slm-user') return userMap.get(actor.userId)?.displayName ?? tr.text(AppEvents_Msgs.unnamedActors['slm-user'])
		if (actor.type === 'ingame-user') return playerName(actor.playerId) ?? AppEvents_Msgs.unnamedActors['ingame-user']
		if (actor.type === 'plugin') return plugins.find((p) => p.id === actor.pluginId)?.name ?? actor.pluginId
		return tr.text(AppEvents_Msgs.unnamedActors.system)
	}

	const headerRef = React.useRef<HTMLDivElement>(null)

	return (
		<Card>
			<StickyGroup stickyRef={headerRef}>
				<CardHeader ref={headerRef} className="">
					<CardTitle>{tr.text(AppEvents_Msgs.auditLog())}</CardTitle>
					<CardDescription>{tr.text(AppEvents_Msgs.auditLogBlurb())}</CardDescription>
				</CardHeader>
				<CardContent>
					{events.length === 0 ? (
						<p className="text-sm text-muted-foreground">{tr.text(AppEvents_Msgs.noEvents())}</p>
					) : (
						<div className="max-h-[32rem] overflow-y-auto">
							{events.map((e) => (
								<AuditLogEntry key={e.id} event={e} actorName={actorName(e.actor)} playerName={playerName} />
							))}
						</div>
					)}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}

// one audit row: a summary line, expandable to the event's full payload. bigints (user ids) aren't JSON-serializable,
// so they're stringified rather than dropped.
function AuditLogEntry({
	event,
	actorName,
	playerName,
}: {
	event: AppEvents.AppEvent
	actorName: string
	playerName: (id: string) => string | undefined
}) {
	return (
		<details className="border-b py-1 last:border-0 group">
			<summary className="flex gap-2 items-baseline text-sm cursor-pointer list-none">
				<Icons.ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
				<span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{new Date(event.time).toLocaleString()}</span>
				<span className="font-medium whitespace-nowrap">{actorName}</span>
				<span className="text-muted-foreground grow min-w-0 wrap-break-word">{AppEvents_Msgs.describeAppEvent(event, playerName)}</span>
				{event.serverId && <span className="text-xs text-muted-foreground whitespace-nowrap">{event.serverId}</span>}
			</summary>
			<pre className="mt-1 ml-5 max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs">
				{JSON.stringify(event, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}
			</pre>
		</details>
	)
}

// Format/Reset/Save for a YAML-mode section. Lives in the editor's own header row (SchemaYamlEditor's `toolbar` slot)
// rather than below it, so it stays reachable once the editor goes fullscreen and covers the page.
function YamlEditorToolbar({
	editorRef,
	deniedPaths,
	canSave,
	saving,
	onSave,
}: {
	editorRef: React.RefObject<SchemaYamlEditorHandle | null>
	deniedPaths: string[]
	canSave: boolean
	saving: boolean
	onSave: () => void
}) {
	return (
		<>
			{deniedPaths.length > 0 && (
				<p className="min-w-0 truncate text-xs text-warn">
					{tr.text(SETTINGS_Msgs.notPermittedToModify())}{' '}
					{deniedPaths.map((p) => (
						<code key={p} className="mx-0.5">
							{p}
						</code>
					))}
				</p>
			)}
			<Button size="sm" variant="outline" onClick={() => editorRef.current?.format()}>
				<Icons.Braces className="h-4 w-4" />
				{tr.text(SETTINGS_Msgs.format())}
			</Button>
			<Button size="sm" variant="outline" onClick={() => editorRef.current?.reset()}>
				{tr.text(SETTINGS_Msgs.reset())}
			</Button>
			<Button size="sm" disabled={!canSave || saving} onClick={onSave}>
				{saving ? tr.text(SETTINGS_Msgs.saving()) : tr.text(SETTINGS_Msgs.save())}
			</Button>
		</>
	)
}

function LabeledInput({ label, ...props }: { label: string } & React.ComponentProps<typeof Input>) {
	const id = React.useId()
	return (
		<div className="space-y-1">
			<Label htmlFor={id}>{label}</Label>
			<Input id={id} {...props} />
		</div>
	)
}

function ServerStatusBadge({ state }: { state: SETTINGS_Msgs.ServerLifecycleState }) {
	const label = tr.text(SETTINGS_Msgs.serverLifecycleLabels[state])
	switch (state) {
		case 'running':
			return (
				<span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
					<span className="h-2 w-2 rounded-full bg-added" />
					{label}
				</span>
			)
		case 'stopped':
			return (
				<span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
					<span className="h-2 w-2 rounded-full border border-muted-foreground/60" />
					{label}
				</span>
			)
		case 'starting':
		case 'stopping':
			return (
				<span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
					<Spinner className="size-3" />
					{label}
				</span>
			)
		case 'broken':
			return (
				<span className="flex items-center gap-1 text-xs font-normal text-destructive">
					<Icons.TriangleAlert className="h-3 w-3" />
					{label}
				</span>
			)
		default:
			assertNever(state)
	}
}

type PublicServer = { id: string; displayName: string; enabled: boolean; broken: boolean; defaultServer: boolean }

// the sentinel selection value for the (unsaved) new-server form
const NEW_SERVER_SELECTION = '__new__'

function lifecycleState(server: PublicServer, inflight: { startingId?: string; stoppingId?: string }): SETTINGS_Msgs.ServerLifecycleState {
	if (server.broken) return 'broken'
	if (inflight.startingId === server.id) return 'starting'
	if (inflight.stoppingId === server.id) return 'stopping'
	return server.enabled ? 'running' : 'stopped'
}

// picks the server to show first: a broken one (so it's noticed and repaired) wins, then the default, then the first
function pickDefaultSelection(servers: PublicServer[]): string | null {
	return (servers.find((s) => s.broken) ?? servers.find((s) => s.defaultServer) ?? servers[0])?.id ?? null
}

// the server registry: a full-width list of servers, each row carrying its own lifecycle controls (status, default,
// start/stop, delete), above a "Server Settings" card holding the selected server's settings. All editing state lives
// in per-server settings-editor frames (kept alive by the route regardless of which server is shown), so drafts
// survive switching servers and the save panel aggregates them.
function ServersSection({
	servers,
	sectionKeys,
	canManage,
	canCreate,
	creating,
	onAddServer,
	onCancelCreate,
}: {
	servers: PublicServer[]
	sectionKeys: SettingsEditorFrame.Key[]
	canManage: boolean
	canCreate: boolean
	creating: boolean
	onAddServer: () => void
	onCancelCreate: () => void
}) {
	const deleteServersDenied = RbacClient.usePermsCheck(RBAC.perm('admin:delete-servers'))
	const openDialog = useAlertDialog()

	const onDenied = { onSuccess: (res: any) => res?.code === 'err:permission-denied' && RbacClient.handlePermissionDenied(res) }
	const enableMutation = useMutation(RPC.orpc.settings.admin.enableServer.mutationOptions(onDenied))
	const disableMutation = useMutation(RPC.orpc.settings.admin.disableServer.mutationOptions(onDenied))
	const deleteMutation = useMutation(RPC.orpc.settings.admin.deleteServer.mutationOptions(onDenied))
	const setDefaultMutation = useMutation(RPC.orpc.settings.admin.setDefaultServer.mutationOptions(onDenied))
	const busy = enableMutation.isPending || disableMutation.isPending || deleteMutation.isPending || setDefaultMutation.isPending
	// the start/stop RPCs only resolve once the managed server is fully spun up / torn down, so the mutation's in-flight
	// window is exactly the transitional period
	const inflight = {
		startingId: enableMutation.isPending ? enableMutation.variables?.serverId : undefined,
		stoppingId: disableMutation.isPending ? disableMutation.variables?.serverId : undefined,
	}

	// the TOC (and page-load fragments) navigate to a server's anchor, but only the selected server is mounted, so the
	// request is seeded from the page-load fragment and then updated by live navigations. It stays a request rather than
	// the answer: the server it names may not have streamed in yet, and may be deleted later.
	const [requestedSelection, setSelected] = React.useState<string | null>(() => {
		const anchor = SettingsNav.currentAnchor()
		const serverId = anchor && SettingsNav.serverForAnchor(anchor)
		return serverId && serverId !== NEW_SERVER_SELECTION ? serverId : null
	})
	React.useEffect(() => {
		return SettingsNav.onAnchorNavigate((id) => {
			const serverId = SettingsNav.serverForAnchor(id)
			if (serverId && serverId !== NEW_SERVER_SELECTION) setSelected(serverId)
		})
	}, [])

	const selected = creating
		? NEW_SERVER_SELECTION
		: requestedSelection && requestedSelection !== NEW_SERVER_SELECTION && servers.some((s) => s.id === requestedSelection)
			? requestedSelection
			: pickDefaultSelection(servers)

	async function handleDelete(server: PublicServer) {
		const msg = tr.confirm(SETTINGS_Msgs.confirmDeleteServer(server.displayName, server.id))
		const result = await openDialog({
			title: msg.title,
			description: msg.description,
			buttons: [{ id: 'confirm', label: msg.confirmLabel, variant: 'destructive' }],
		})
		if (result === 'confirm') deleteMutation.mutate({ serverId: server.id })
	}

	const selectedServer = servers.find((s) => s.id === selected)
	const serverKey = selectedServer && sectionKeys.find((k) => k.kind === 'server' && k.serverId === selectedServer.id)
	const newServerKey = sectionKeys.find((k) => k.kind === 'new-server')

	return (
		<div className="space-y-4">
			<ServerList
				servers={servers}
				selected={selected}
				onSelect={setSelected}
				inflight={inflight}
				busy={busy}
				canManage={canManage}
				canDelete={!deleteServersDenied}
				canCreate={canManage && canCreate}
				creating={creating}
				onAddServer={onAddServer}
				onToggle={(server) =>
					server.enabled ? disableMutation.mutate({ serverId: server.id }) : enableMutation.mutate({ serverId: server.id })
				}
				onSetDefault={(server) => setDefaultMutation.mutate({ serverId: server.id })}
				onDelete={handleDelete}
			/>
			{creating && newServerKey ? (
				<div id={`section:server:${NEW_SERVER_SELECTION}`} className="scroll-mt-2">
					<CreateServerSection stores={{ settingsEditor: newServerKey }} onCancel={onCancelCreate} />
				</div>
			) : selectedServer && serverKey ? (
				// the anchor id lives on the list row, so navigating to a server scrolls to it in the list rather than past it;
				// this card is highlighted along with the row so it's clear which settings the anchor opened
				<div
					id="section:server-settings"
					data-anchor-companion={`section:server:${selectedServer.id}`}
					className="scroll-mt-2 rounded-xl"
				>
					<ServerSettingsSection server={selectedServer} stores={{ settingsEditor: serverKey }} />
				</div>
			) : (
				<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.selectServer())}</p>
			)}
		</div>
	)
}

function ServerList({
	servers,
	selected,
	onSelect,
	inflight,
	busy,
	canManage,
	canDelete,
	canCreate,
	creating,
	onAddServer,
	onToggle,
	onSetDefault,
	onDelete,
}: {
	servers: PublicServer[]
	selected: string | null
	onSelect: (id: string) => void
	inflight: { startingId?: string; stoppingId?: string }
	busy: boolean
	canManage: boolean
	canDelete: boolean
	canCreate: boolean
	creating: boolean
	onAddServer: () => void
	onToggle: (server: PublicServer) => void
	onSetDefault: (server: PublicServer) => void
	onDelete: (server: PublicServer) => void
}) {
	return (
		<div className="space-y-2">
			<div className="space-y-1">
				{servers.length === 0 && <p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.noServersConfigured())}</p>}
				{servers.map((server) => (
					<ServerRow
						key={server.id}
						server={server}
						selected={server.id === selected}
						onSelect={onSelect}
						inflight={inflight}
						busy={busy}
						canManage={canManage}
						canDelete={canDelete}
						onToggle={onToggle}
						onSetDefault={onSetDefault}
						onDelete={onDelete}
					/>
				))}
			</div>
			{canCreate && (
				<Button variant="outline" size="sm" disabled={creating} onClick={onAddServer}>
					<Icons.Plus className="mr-1 h-4 w-4" />
					{tr.text(SETTINGS_Msgs.addManagedServer())}
				</Button>
			)}
		</div>
	)
}

function ServerRow({
	server,
	selected,
	onSelect,
	inflight,
	busy,
	canManage,
	canDelete,
	onToggle,
	onSetDefault,
	onDelete,
}: {
	server: PublicServer
	selected: boolean
	onSelect: (id: string) => void
	inflight: { startingId?: string; stoppingId?: string }
	busy: boolean
	canManage: boolean
	canDelete: boolean
	onToggle: (server: PublicServer) => void
	onSetDefault: (server: PublicServer) => void
	onDelete: (server: PublicServer) => void
}) {
	const consoleDenied = RbacClient.usePermsCheck(RBAC.perm('squad-server:view-console', { serverId: server.id }))
	const openConsoleWindow = useOpenServerConsoleWindow({ serverId: server.id })

	return (
		<div
			id={`section:server:${server.id}`}
			className={cn(
				'flex scroll-mt-2 items-center gap-3 rounded-md border px-2.5 py-2',
				selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/50',
			)}
		>
			<button
				type="button"
				onClick={() => onSelect(server.id)}
				className="flex min-w-0 grow flex-col gap-0.5 text-left"
				aria-pressed={selected}
			>
				<span className="truncate text-sm font-medium">{server.displayName}</span>
				<span className="truncate font-mono text-xs text-muted-foreground">{server.id}</span>
			</button>
			<ServerStatusBadge state={lifecycleState(server, inflight)} />
			<PermissionDeniedTooltip denied={consoleDenied}>
				<Button
					size="icon"
					variant="ghost"
					disabled={!!consoleDenied}
					title={tr.text(SS_Msgs.serverConsole())}
					onClick={(e) => openConsoleWindow(e.currentTarget)}
				>
					<Icons.Terminal className="h-4 w-4" />
				</Button>
			</PermissionDeniedTooltip>
			{canManage && (
				<>
					<div className="flex items-center gap-1.5">
						<Checkbox
							id={`default-${server.id}`}
							checked={server.defaultServer}
							disabled={busy || server.defaultServer}
							onCheckedChange={(checked) => checked && onSetDefault(server)}
						/>
						<Label htmlFor={`default-${server.id}`} className="text-sm font-normal cursor-pointer">
							{tr.text(SETTINGS_Msgs.defaultServer())}
						</Label>
					</div>
					<Button
						size="sm"
						variant={server.enabled ? 'destructive' : 'outline'}
						className={cn('w-28', server.broken && 'invisible')}
						disabled={busy || server.broken}
						title={server.enabled ? tr.text(SETTINGS_Msgs.disconnectServerHint()) : tr.text(SETTINGS_Msgs.connectServerHint())}
						onClick={() => onToggle(server)}
					>
						{server.enabled ? tr.text(SETTINGS_Msgs.disconnectServer()) : tr.text(SETTINGS_Msgs.connectServer())}
					</Button>
					{canDelete && (
						<Button
							size="icon"
							variant="ghost"
							disabled={busy}
							title={tr.text(SETTINGS_Msgs.deleteManagedServer())}
							onClick={() => onDelete(server)}
						>
							<Icons.Trash2 className="h-4 w-4" />
						</Button>
					)}
				</>
			)}
		</div>
	)
}

// GUI/YAML editor for the settings of whichever server is selected in the list above. GUI mode routes save/reset
// through the shared bottom panel; YAML mode keeps its own inline toolbar (a power-user escape hatch). Server settings
// have no codec transforms, so the edit/input shape equals the stored shape (no encode step). All editing state lives
// in the section's settings-editor frame; this component is a view over it.
function ServerSettingsSection({
	server,
	stores,
}: {
	server: { id: string; displayName: string; broken: boolean }
	stores: SettingsEditorFrame.KeyProp
}) {
	const key = stores.settingsEditor
	const access = RbacClient.useServerSettingsAccess(server.id)
	const perms = RbacClient.useSuspendableLoggedInUserPerms()
	const state = Zus.useStore(key, (s: SettingsEditorFrame.SettingsEditor) => s)
	const { mode, changes, issues, valid, saving, loadFailed, loading, draft, saved } = state
	// without write-sensitive the server redacts connections, so edit/validate against the connections-free schema
	const schema = SettingsEditorFrame.Sel.schema(state)

	const value$ = SettingsEditorFrame.draftValueState(key)
	const reset$ = state.reset$
	const onFormChange = (v: any) => SettingsEditorFrame.Actions.setDraft({ settingsEditor: key }, v)
	const editorRef = React.useRef<SchemaYamlEditorHandle>(null)
	const headerRef = React.useRef<HTMLDivElement>(null)
	const openDialog = useAlertDialog()

	// mirror of the server-side grant check so out-of-grant edits surface before save
	const deniedPaths = SettingsEditorFrame.deniedSettingPaths(state, perms)

	// write-sensitive permits editing connections independent of any general write grant; widen the form's gating so a
	// sensitive user can edit connections even with no (or only path-restricted) write access
	const formWriteAccess: RBAC.SettingsWriteAccess = React.useMemo(() => {
		if (!access.sensitive || access.write.kind === 'all') return access.write
		const paths = access.write.kind === 'paths' ? access.write.paths : []
		return { kind: 'paths', paths: [...paths, 'connections'] }
	}, [access.write, access.sensitive])

	async function handleJsonSave() {
		if (!valid) return
		const msg = tr.confirm(SETTINGS_Msgs.confirmSave(server.displayName))
		const result = await openDialog({
			title: msg.title,
			content: <SettingsChangeList changes={changes} />,
			buttons: [{ id: 'save', label: msg.confirmLabel }],
		})
		if (result === 'save') void SettingsEditorFrame.Actions.save({ settingsEditor: key })
	}

	function switchMode(next: 'gui' | 'yaml') {
		SettingsEditorFrame.Actions.setMode({ settingsEditor: key }, next)
	}

	const ready = !loadFailed && !loading && draft !== undefined

	return (
		<Card>
			<StickyGroup stickyRef={headerRef}>
				<CardHeader ref={headerRef} className="">
					<div className="flex items-center justify-between gap-2">
						<div>
							<CardTitle className="flex items-center gap-2">
								{tr.text(SETTINGS_Msgs.serverSettings())}
								{access.write.kind === 'none' && (
									<span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
										{tr.text(SETTINGS_Msgs.readOnly())}
									</span>
								)}
							</CardTitle>
							<CardDescription>
								{server.displayName} <span className="font-mono">({server.id})</span>
								{server.broken && <span className="ml-2 text-destructive">{tr.text(SETTINGS_Msgs.serverBroken())}</span>}
							</CardDescription>
							{access.write.kind === 'paths' && (
								<p className="text-xs text-muted-foreground">
									{tr.text(SETTINGS_Msgs.onlyModifiable())}{' '}
									{access.write.paths.map((p) => (
										<code key={p} className="mx-0.5">
											{p}
										</code>
									))}
								</p>
							)}
						</div>
						<div role="group" aria-label={tr.text(SETTINGS_Msgs.serverEditorModeLabel())} className="fd-grp">
							<Button size="sm" data-state={mode === 'gui' ? 'on' : 'off'} onClick={() => switchMode('gui')}>
								GUI
							</Button>
							<Button size="sm" data-state={mode === 'yaml' ? 'on' : 'off'} onClick={() => switchMode('yaml')}>
								YAML
							</Button>
						</div>
					</div>
				</CardHeader>
				{/* pt-3 keeps the first group's anchor-highlight ring clear of the sticky header */}
				<CardContent className="space-y-4 pt-3">
					{loadFailed ? (
						<p className="text-sm text-destructive">{tr.text(SETTINGS_Msgs.loadFailed(loadFailed))}</p>
					) : !ready ? (
						<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.loading())}</p>
					) : mode === 'gui' ? (
						<SettingsForm
							schema={schema}
							value$={value$}
							reset$={reset$}
							onChange={onFormChange}
							saved={saved}
							idPrefix={`setting:server:${server.id}:`}
							priorityKeys={SERVER_SETTINGS_PRIORITY_KEYS}
							advancedPaths={ADVANCED_SERVER_SETTINGS_PATHS}
							issues={issues}
							writeAccess={formWriteAccess}
						/>
					) : (
						<React.Suspense fallback={<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.loadingEditor())}</p>}>
							<SchemaYamlEditor
								ref={editorRef}
								schema={schema}
								commentsKey={SETTINGS.COMMENTS_KEY}
								value={draft}
								onValidChange={(v: any) => SettingsEditorFrame.Actions.setYamlValid({ settingsEditor: key }, v)}
								onReady={() => SettingsNav.scrollToAnchorSettled('section:server-settings')}
								minHeightPx={350}
								label={tr.text(SETTINGS_Msgs.serverSettings())}
								toolbar={
									<YamlEditorToolbar
										editorRef={editorRef}
										deniedPaths={deniedPaths}
										canSave={changes.length > 0 && valid && deniedPaths.length === 0}
										saving={saving}
										onSave={handleJsonSave}
									/>
								}
							/>
						</React.Suspense>
					)}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}

// create a new server on the same generic form; id + displayName sit above the settings form. Saves via the shared
// bottom panel (creating the server), consistent with editing; creation is gated by manage-servers + write-sensitive
// rather than path grants, so no denied-path mirror here.
function CreateServerSection({ stores, onCancel }: { stores: SettingsEditorFrame.KeyProp; onCancel: () => void }) {
	const key = stores.settingsEditor
	const state = Zus.useStore(key, (s: SettingsEditorFrame.SettingsEditor) => s)
	const { mode, draft, issues, newId, newDisplayName } = state

	const value$ = SettingsEditorFrame.draftValueState(key)
	const reset$ = state.reset$
	const onFormChange = (v: any) => SettingsEditorFrame.Actions.setDraft({ settingsEditor: key }, v)
	const editorRef = React.useRef<SchemaYamlEditorHandle>(null)
	const headerRef = React.useRef<HTMLDivElement>(null)

	const idRes = SS.ServerIdSchema.safeParse(newId)

	return (
		<Card>
			<StickyGroup stickyRef={headerRef}>
				<CardHeader ref={headerRef} className="">
					<div className="flex items-center justify-between gap-2">
						<div>
							<CardTitle>{tr.text(SETTINGS_Msgs.newManagedServer())}</CardTitle>
							<CardDescription>{tr.text(SETTINGS_Msgs.newServerBlurb())}</CardDescription>
						</div>
						<div className="flex items-center gap-2">
							<div role="group" aria-label={tr.text(SETTINGS_Msgs.newServerEditorModeLabel())} className="fd-grp">
								<Button
									size="sm"
									data-state={mode === 'gui' ? 'on' : 'off'}
									onClick={() => SettingsEditorFrame.Actions.setMode({ settingsEditor: key }, 'gui')}
								>
									GUI
								</Button>
								<Button
									size="sm"
									data-state={mode === 'yaml' ? 'on' : 'off'}
									onClick={() => SettingsEditorFrame.Actions.setMode({ settingsEditor: key }, 'yaml')}
								>
									YAML
								</Button>
							</div>
							<Button size="sm" variant="outline" onClick={onCancel}>
								{tr.text(SETTINGS_Msgs.cancel())}
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4 pt-3">
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<LabeledInput
								label={tr.text(SETTINGS_Msgs.serverIdLabel())}
								placeholder={tr.text(SETTINGS_Msgs.serverIdPlaceholder())}
								defaultValue={newId}
								onChange={(e) => SettingsEditorFrame.Actions.setNewServerFields({ settingsEditor: key }, { id: e.target.value })}
							/>
							{newId.length > 0 && !idRes.success && (
								<p className="text-xs text-destructive">{tr.text(SETTINGS_Msgs.invalidServerId())}</p>
							)}
						</div>
						<LabeledInput
							label={tr.text(SETTINGS_Msgs.displayNameLabel())}
							placeholder={tr.text(SETTINGS_Msgs.displayNamePlaceholder())}
							defaultValue={newDisplayName}
							onChange={(e) =>
								SettingsEditorFrame.Actions.setNewServerFields({ settingsEditor: key }, { displayName: e.target.value })
							}
						/>
					</div>
					{mode === 'gui' ? (
						<SettingsForm
							schema={SETTINGS.ServerSettingsSchema}
							value$={value$}
							reset$={reset$}
							onChange={onFormChange}
							saved={SettingsEditorFrame.NEW_SERVER_DRAFT}
							idPrefix="setting:server:__new__:"
							priorityKeys={SERVER_SETTINGS_PRIORITY_KEYS}
							advancedPaths={ADVANCED_SERVER_SETTINGS_PATHS}
							issues={issues}
						/>
					) : (
						<React.Suspense fallback={<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.loadingEditor())}</p>}>
							<SchemaYamlEditor
								ref={editorRef}
								schema={SETTINGS.ServerSettingsSchema}
								commentsKey={SETTINGS.COMMENTS_KEY}
								value={draft}
								onValidChange={(v: any) => SettingsEditorFrame.Actions.setYamlValid({ settingsEditor: key }, v)}
								onReady={() => SettingsNav.scrollToAnchorSettled(`section:server:${NEW_SERVER_SELECTION}`)}
								minHeightPx={350}
								label={tr.text(SETTINGS_Msgs.serverSettings())}
							/>
						</React.Suspense>
					)}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}

// all editing state lives in the section's settings-editor frame (which also owns the globalSettings$ subscription
// and permission-denied handling); this component is a view over it
function GlobalSettingsSection({ stores }: { stores: SettingsEditorFrame.KeyProp }) {
	const key = stores.settingsEditor
	const { write: writeAccess } = RbacClient.useGlobalSettingsAccess()
	const perms = RbacClient.useSuspendableLoggedInUserPerms()
	const state = Zus.useStore(key, (s: SettingsEditorFrame.SettingsEditor) => s)
	const { mode, changes, issues, valid, saving, draft, saved, denied } = state

	const value$ = SettingsEditorFrame.draftValueState(key)
	const reset$ = state.reset$
	const onFormChange = (v: any) => SettingsEditorFrame.Actions.setDraft({ settingsEditor: key }, v)
	const editorRef = React.useRef<SchemaYamlEditorHandle>(null)
	// the card header pins to the top of the scroll column; the form's section headers stack beneath it
	const cardHeaderRef = React.useRef<HTMLDivElement>(null)
	const openDialog = useAlertDialog()

	// mirror of the server-side grant check so out-of-grant edits surface before save
	const deniedPaths = SettingsEditorFrame.deniedSettingPaths(state, perms)

	if (denied) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>{tr.text(SETTINGS_Msgs.globalSettings())}</CardTitle>
					<CardDescription>{tr.text(SETTINGS_Msgs.noGlobalAccess())}</CardDescription>
				</CardHeader>
			</Card>
		)
	}

	if (saved === undefined || draft === undefined) return null

	async function handleJsonSave() {
		if (!valid) return
		const msg = tr.confirm(SETTINGS_Msgs.confirmSave())
		const result = await openDialog({
			title: msg.title,
			content: <SettingsChangeList changes={changes} />,
			buttons: [{ id: 'save', label: msg.confirmLabel }],
		})
		if (result === 'save') void SettingsEditorFrame.Actions.save({ settingsEditor: key })
	}

	function switchMode(next: 'gui' | 'yaml') {
		SettingsEditorFrame.Actions.setMode({ settingsEditor: key }, next)
	}

	return (
		<Card>
			<StickyGroup stickyRef={cardHeaderRef}>
				<CardHeader ref={cardHeaderRef} className="">
					<div className="flex items-center justify-between gap-2">
						<div>
							<CardTitle className="flex items-center gap-2">
								{tr.text(SETTINGS_Msgs.globalSettings())}
								{writeAccess.kind === 'none' && (
									<span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
										{tr.text(SETTINGS_Msgs.readOnly())}
									</span>
								)}
							</CardTitle>
							<CardDescription>{tr.text(SETTINGS_Msgs.globalSettingsBlurb())}</CardDescription>
							{writeAccess.kind === 'paths' && (
								<p className="text-xs text-muted-foreground">
									{tr.text(SETTINGS_Msgs.onlyModifiable())}{' '}
									{writeAccess.paths.map((p) => (
										<code key={p} className="mx-0.5">
											{p}
										</code>
									))}
								</p>
							)}
						</div>
						<div role="group" aria-label={tr.text(SETTINGS_Msgs.globalEditorModeLabel())} className="fd-grp">
							<Button size="sm" data-state={mode === 'gui' ? 'on' : 'off'} onClick={() => switchMode('gui')}>
								GUI
							</Button>
							<Button size="sm" data-state={mode === 'yaml' ? 'on' : 'off'} onClick={() => switchMode('yaml')}>
								YAML
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4 pt-3">
					{mode === 'gui' ? (
						<SettingsForm
							schema={SETTINGS.GlobalSettingsSchema}
							value$={value$}
							reset$={reset$}
							onChange={onFormChange}
							saved={saved}
							groups={GLOBAL_SETTINGS_GROUPS}
							advancedPaths={ADVANCED_GLOBAL_SETTINGS_PATHS}
							issues={issues}
							writeAccess={writeAccess}
						/>
					) : (
						// GUI mode uses the shared bottom control panel; YAML mode keeps its own toolbar, inside the editor
						<React.Suspense fallback={<p className="text-sm text-muted-foreground">{tr.text(SETTINGS_Msgs.loadingEditor())}</p>}>
							<SchemaYamlEditor
								ref={editorRef}
								schema={SETTINGS.GlobalSettingsSchema}
								commentsKey={SETTINGS.COMMENTS_KEY}
								value={draft}
								onValidChange={(v: any) => SettingsEditorFrame.Actions.setYamlValid({ settingsEditor: key }, v)}
								onReady={() => SettingsNav.scrollToAnchorSettled('section:global')}
								minHeightPx={450}
								label={tr.text(SETTINGS_Msgs.globalSettings())}
								toolbar={
									<YamlEditorToolbar
										editorRef={editorRef}
										deniedPaths={deniedPaths}
										canSave={changes.length > 0 && valid && deniedPaths.length === 0}
										saving={saving}
										onSave={handleJsonSave}
									/>
								}
							/>
						</React.Suspense>
					)}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}
