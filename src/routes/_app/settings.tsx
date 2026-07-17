import type SchemaJsonEditorComponent from '@/components/schema-json-editor'
import type { SchemaJsonEditorHandle } from '@/components/schema-json-editor.types'
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
import { createId } from '@/lib/id'
import { useRefConstructor } from '@/lib/react'
import { ADVANCED_GLOBAL_SETTINGS_PATHS, ADVANCED_SERVER_SETTINGS_PATHS, GLOBAL_SETTINGS_GROUPS, SERVER_SETTINGS_PRIORITY_KEYS } from '@/lib/settings-groups'
import * as SettingsNav from '@/lib/settings-nav'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as ZusUtils from '@/lib/zustand'
import * as AppEvents from '@/models/app-events.models'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UsersClient from '@/systems/users.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'

// stable empty-servers reference while public settings haven't loaded, keeping the readable-servers memo stable
const NO_SERVERS: never[] = []

// lazily loaded so the CodeMirror editor bundle isn't paid for until an editor is actually shown.
// the `as` casts restore the generic component signature that React.lazy erases.
const SchemaJsonEditor = React.lazy(
	() => import('@/components/schema-json-editor') as unknown as Promise<{ default: React.FC<any> }>,
) as unknown as typeof SchemaJsonEditorComponent

export const Route = createFileRoute('/_app/settings')({
	head: () => ({
		meta: [{ title: 'SLM - Settings' }],
	}),

	component: RouteComponent,
})

function RouteComponent() {
	const manageServersDenied = RbacClient.usePermsCheck(RBAC.perm('admin:manage-servers'))
	const globalAccess = RbacClient.useGlobalSettingsAccess()
	const loggedInPerms = RbacClient.useLoggedInPerms()
	// creating a server requires supplying its connection details, so it needs write-sensitive in addition to manage-servers
	const canCreateServers = React.useMemo(() => RBAC.canCreateServers(loggedInPerms), [loggedInPerms])
	// scopes this visit's frame instances: a fresh pageId per mount means fresh drafts + a fresh raw-settings fetch
	const pageId = useRefConstructor(() => createId(4)).current
	// non-null while the new-server form is open; a fresh nonce per "Add Server" click yields a clean frame instance
	const [creatingNonce, setCreatingNonce] = React.useState<string | null>(null)

	// a server section renders for every server the user may at least read; registry management is gated separately
	const allServers = ZusUtils.useStore(SettingsClient.PublicSettingsStore, (s) => s?.servers) ?? NO_SERVERS
	const servers = React.useMemo(
		() => allServers.filter((s) => RBAC.canReadServerSettings(loggedInPerms, s.id)),
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
	const teardownCtl = useRefConstructor(() => ({ keys: new Set<SettingsEditorFrame.Key>(), pending: null as number | null })).current
	React.useEffect(() => {
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
	}, [sectionKeys, teardownCtl])

	const sectionStates = SettingsEditorFrame.useSectionStates(sectionKeys)
	// per-section gui/json modes feed the TOC (JSON mode has no per-field anchors); `created` collapses the new-server
	// form once its save lands (the created server then renders as a regular section via the public-settings watch)
	const derived = React.useMemo(() => {
		const serverModes: Record<string, 'gui' | 'json'> = {}
		let globalMode: 'gui' | 'json' = 'gui'
		let newServerMode: 'gui' | 'json' = 'gui'
		let created = false
		let anyDirty = false
		for (const s of sectionStates) {
			if (s.kind === 'server') serverModes[s.serverId!] = s.mode
			else if (s.kind === 'global') globalMode = s.mode
			else {
				newServerMode = s.mode
				created = s.created
			}
			if (SettingsEditorFrame.Sel.dirty(s)) anyDirty = true
		}
		return { serverModes, globalMode, newServerMode, created, anyDirty }
	}, [sectionStates])
	const creating = creatingNonce !== null && !derived.created

	// block in-app navigation and tab close while any section holds unsaved edits (same pattern as filter-edit)
	useBlocker({
		enableBeforeUnload: derived.anyDirty,
		shouldBlockFn: () => {
			const dirty = sectionKeys.some((k) => {
				const s = frameManager.getState(k)
				return !!s && SettingsEditorFrame.Sel.dirty(s)
			})
			if (!dirty) return false
			const shouldLeave = confirm('You have unsaved settings changes. Are you sure you want to leave?')
			return !shouldLeave
		},
	})

	// the fragment to scroll to on load, captured once. Handled lazily below once its owning section has rendered, since
	// the sections load async (per-server fetch, global-settings Suspense) and a `setting:*` field only exists after its
	// section mounts.
	const initialAnchor = useRefConstructor(() => ({ id: SettingsNav.currentAnchor(), handled: false }))

	// initial page-load fragment: gate on the owning section actually being in the DOM (re-checked as sections stream in
	// via sectionStates), then hand off to the exact same navigateToAnchor path a TOC click uses. `handled` latches so
	// later sectionStates changes (form edits) don't re-trigger it; the settle loop self-terminates on unmount.
	React.useEffect(() => {
		const st = initialAnchor.current
		if (st.handled || !st.id) return
		const section = SettingsNav.sectionForAnchor(st.id)
		// wait until the owning section has rendered; an unrecognized anchor (section === null) is handled immediately
		if (section && !document.getElementById(section)) return
		st.handled = true
		SettingsNav.navigateToAnchor(st.id)
	}, [sectionStates, initialAnchor])

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

	// when the user clicks "Add Server", scroll the new-server config into view once it mounts (the section renders on
	// the next frame). Existing servers scroll via the pencil/Fix buttons in the management card.
	React.useEffect(() => {
		if (!creating) return
		return SettingsNav.scrollToAnchorSettled('section:server:__new__', { deadlineMs: 1500 })
	}, [creating])

	if (manageServersDenied && !globalAccess.canRead && servers.length === 0) {
		return (
			<div className="w-full h-full grid place-items-center">
				<p className="text-muted-foreground">You don't have permission to access settings.</p>
			</div>
		)
	}

	return (
		// bounded to the viewport (navbar h-16 + outlet p-4 = 6rem) so the two columns can scroll independently;
		// the outlet wrapper is overflow-hidden, which would otherwise break sticky/independent scrolling
		<div className="flex w-full h-[calc(100dvh-6rem)]">
			{/* the TOC only earns its width once the content column has room to spare, so it scales back on narrower viewports */}
			<aside className="w-52 md:w-60 lg:w-72 xl:w-80 shrink-0 overflow-hidden border-r pr-2 py-2">
				<SettingsToc
					showServers={!manageServersDenied || servers.length > 0}
					showGlobal={globalAccess.canRead}
					globalMode={derived.globalMode}
					servers={servers}
					serverModes={derived.serverModes}
					creatingServer={creating}
					newServerMode={derived.newServerMode}
				/>
			</aside>
			{
				/* `main` spans the whole non-TOC area (the content column is centred inside it) so a wheel anywhere outside the
			    TOC scrolls the settings, rather than landing on the non-scrollable outlet wrapper.
			    `relative` is load-bearing: sr-only elements in the form are position:absolute, and without a positioned
			    scroll container they escape main's clipping and stretch the document's scroll height to the full unclipped
			    content height, making the whole app (navbar included) scroll away. */
			}
			<main className="relative flex-1 min-w-0 overflow-y-auto">
				{/* no top padding: sticky section headers pin flush to the top, otherwise scrolled content bleeds into the gap */}
				<div className="mx-auto w-full max-w-[68rem] px-4 pb-2 space-y-6">
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
					{globalAccess.canRead && (() => {
						const key = sectionKeys.find((k) => k.kind === 'global')
						if (!key) return null
						// Subscribe has no fallback of its own: the suspension is handed to StateBoundary, which also
						// catches the first-emit timeout if global settings never arrive
						return (
							<StateBoundary label="global settings">
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
			<SettingsSavePanel sectionKeys={sectionKeys} />
		</div>
	)
}

function AuditLogSection() {
	const { data } = useQuery(RPC.orpc.appEvents.list.queryOptions({ input: { limit: 100 } }))
	const events: AppEvents.AppEvent[] = data?.code === 'ok' ? data.events : []
	const userIds = [...new Set(events.flatMap(e => e.actor.type === 'slm-user' ? [e.actor.userId] : []))]
	const usersRes = UsersClient.useUsers(userIds, { enabled: userIds.length > 0 })
	const userMap = new Map((usersRes.data?.code === 'ok' ? usersRes.data.users : []).map(u => [u.discordId, u]))

	function actorName(actor: AppEvents.Actor): string {
		if (actor.type === 'slm-user') return userMap.get(actor.userId)?.displayName ?? 'Admin'
		if (actor.type === 'ingame-user') return 'A player'
		return 'System'
	}

	const headerRef = React.useRef<HTMLDivElement>(null)

	return (
		<Card>
			<StickyGroup stickyRef={headerRef}>
				<CardHeader ref={headerRef} className="rounded-t-xl border-b bg-card">
					<CardTitle>Audit Log</CardTitle>
					<CardDescription>Recent actions taken across SLM.</CardDescription>
				</CardHeader>
				<CardContent>
					{events.length === 0
						? <p className="text-sm text-muted-foreground">No events yet.</p>
						: (
							<div className="max-h-[32rem] overflow-y-auto">
								{events.map(e => <AuditLogEntry key={e.id} event={e} actorName={actorName(e.actor)} />)}
							</div>
						)}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}

// one audit row: a summary line, expandable to the event's full payload. bigints (user ids) aren't JSON-serializable,
// so they're stringified rather than dropped.
function AuditLogEntry({ event, actorName }: { event: AppEvents.AppEvent; actorName: string }) {
	return (
		<details className="border-b py-1 last:border-0 group">
			<summary className="flex gap-2 items-baseline text-sm cursor-pointer list-none">
				<Icons.ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
				<span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
					{new Date(event.time).toLocaleString()}
				</span>
				<span className="font-medium whitespace-nowrap">{actorName}</span>
				<span className="text-muted-foreground grow min-w-0 wrap-break-word">{AppEvents.describeAppEvent(event)}</span>
				{event.serverId && <span className="text-xs text-muted-foreground whitespace-nowrap">{event.serverId}</span>}
			</summary>
			<pre className="mt-1 ml-5 max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs">
				{JSON.stringify(event, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}
			</pre>
		</details>
	)
}

// Format/Reset/Save for a JSON-mode section. Lives in the editor's own header row (SchemaJsonEditor's `toolbar` slot)
// rather than below it, so it stays reachable once the editor goes fullscreen and covers the page.
function JsonEditorToolbar(
	{ editorRef, deniedPaths, canSave, saving, onSave }: {
		editorRef: React.RefObject<SchemaJsonEditorHandle | null>
		deniedPaths: string[]
		canSave: boolean
		saving: boolean
		onSave: () => void
	},
) {
	return (
		<>
			{deniedPaths.length > 0 && (
				<p className="min-w-0 truncate text-xs text-amber-500">
					Not permitted to modify: {deniedPaths.map((p) => <code key={p} className="mx-0.5">{p}</code>)}
				</p>
			)}
			<Button size="sm" variant="outline" onClick={() => editorRef.current?.format()}>
				<Icons.Braces className="h-4 w-4" />
				Format
			</Button>
			<Button size="sm" variant="outline" onClick={() => editorRef.current?.reset()}>Reset</Button>
			<Button size="sm" disabled={!canSave || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</Button>
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

type ServerLifecycleState = 'running' | 'stopped' | 'starting' | 'stopping' | 'broken'

function ServerStatusBadge({ state }: { state: ServerLifecycleState }) {
	switch (state) {
		case 'running':
			return (
				<span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
					<span className="h-2 w-2 rounded-full bg-added" />
					Connected
				</span>
			)
		case 'stopped':
			return (
				<span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
					<span className="h-2 w-2 rounded-full border border-muted-foreground/60" />
					Disconnected
				</span>
			)
		case 'starting':
		case 'stopping':
			return (
				<span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
					<Spinner className="size-3" />
					{state === 'starting' ? 'Connecting…' : 'Disconnecting…'}
				</span>
			)
		case 'broken':
			return (
				<span className="flex items-center gap-1 text-xs font-normal text-destructive">
					<Icons.TriangleAlert className="h-3 w-3" />
					Broken
				</span>
			)
		default:
			assertNever(state)
	}
}

type PublicServer = { id: string; displayName: string; enabled: boolean; broken: boolean; defaultServer: boolean }

// the sentinel selection value for the (unsaved) new-server form
const NEW_SERVER_SELECTION = '__new__'

function lifecycleState(
	server: PublicServer,
	inflight: { startingId?: string; stoppingId?: string },
): ServerLifecycleState {
	if (server.broken) return 'broken'
	if (inflight.startingId === server.id) return 'starting'
	if (inflight.stoppingId === server.id) return 'stopping'
	return server.enabled ? 'running' : 'stopped'
}

// picks the server to show first: a broken one (so it's noticed and repaired) wins, then the default, then the first
function pickDefaultSelection(servers: PublicServer[]): string | null {
	return (servers.find((s) => s.broken) ?? servers.find((s) => s.defaultServer) ?? servers[0])?.id ?? null
}

// master-detail for the server registry: pick a server on the left, edit its settings on the right. The server list
// doubles as the old management card, and each server's lifecycle controls (status, start/stop, default, delete) live
// in its detail-card header. All editing state still lives in per-server settings-editor frames (kept alive by the
// route regardless of which detail is shown), so drafts survive switching servers and the save panel aggregates them.
function ServersSection(
	{ servers, sectionKeys, canManage, canCreate, creating, onAddServer, onCancelCreate }: {
		servers: PublicServer[]
		sectionKeys: SettingsEditorFrame.Key[]
		canManage: boolean
		canCreate: boolean
		creating: boolean
		onAddServer: () => void
		onCancelCreate: () => void
	},
) {
	const deleteServersDenied = RbacClient.usePermsCheck(RBAC.perm('admin:delete-servers'))
	const openDialog = useAlertDialog()

	const onDenied = { onSuccess: (res: any) => res?.code === 'err:permission-denied' && RbacClient.handlePermissionDenied(res) }
	const enableMutation = useMutation(RPC.orpc.settings.admin.enableServer.mutationOptions(onDenied))
	const disableMutation = useMutation(RPC.orpc.settings.admin.disableServer.mutationOptions(onDenied))
	const deleteMutation = useMutation(RPC.orpc.settings.admin.deleteServer.mutationOptions(onDenied))
	const setDefaultMutation = useMutation(RPC.orpc.settings.admin.setDefaultServer.mutationOptions(onDenied))
	const busy = enableMutation.isPending || disableMutation.isPending || deleteMutation.isPending || setDefaultMutation.isPending
	// the start/stop RPCs only resolve once the server slice is fully spun up / torn down, so the mutation's in-flight
	// window is exactly the transitional period
	const inflight = {
		startingId: enableMutation.isPending ? enableMutation.variables?.serverId : undefined,
		stoppingId: disableMutation.isPending ? disableMutation.variables?.serverId : undefined,
	}

	const [selected, setSelected] = React.useState<string | null>(() => pickDefaultSelection(servers))
	// keep the selection valid as servers stream in / are deleted, and follow the create flow in and out of the new-server form
	React.useEffect(() => {
		if (creating) {
			setSelected(NEW_SERVER_SELECTION)
			return
		}
		setSelected((cur) => (cur && cur !== NEW_SERVER_SELECTION && servers.some((s) => s.id === cur) ? cur : pickDefaultSelection(servers)))
	}, [creating, servers])

	// the TOC (and page-load fragments) navigate to a server's anchor, but only the selected server is mounted; select
	// whichever server an anchor points at so its section exists for the settle-scroll to land on. Live navigations always
	// win; the page-load fragment is applied only once (once its server has streamed in), so it can't later clobber a
	// manual selection when the server list updates.
	const initialAnchorSelected = React.useRef(false)
	React.useEffect(() => {
		const selectFromAnchor = (id: string) => {
			const serverId = SettingsNav.serverForAnchor(id)
			if (serverId && serverId !== NEW_SERVER_SELECTION && servers.some((s) => s.id === serverId)) setSelected(serverId)
		}
		if (!initialAnchorSelected.current) {
			const anchor = SettingsNav.currentAnchor()
			const serverId = anchor && SettingsNav.serverForAnchor(anchor)
			if (serverId && serverId !== NEW_SERVER_SELECTION && servers.some((s) => s.id === serverId)) {
				setSelected(serverId)
				initialAnchorSelected.current = true
			}
		}
		return SettingsNav.onAnchorNavigate(selectFromAnchor)
	}, [servers])

	async function handleDelete(server: PublicServer) {
		const result = await openDialog({
			title: 'Delete Server',
			description: `Delete server "${server.displayName}" (${server.id})? This cannot be undone.`,
			buttons: [{ id: 'confirm', label: 'Delete', variant: 'destructive' }],
		})
		if (result === 'confirm') deleteMutation.mutate({ serverId: server.id })
	}

	const selectedServer = servers.find((s) => s.id === selected)
	const serverKey = selectedServer && sectionKeys.find((k) => k.kind === 'server' && k.serverId === selectedServer.id)
	const newServerKey = sectionKeys.find((k) => k.kind === 'new-server')

	return (
		<div className="grid grid-cols-[minmax(11rem,17rem)_1fr] gap-4 items-start">
			<ServerList
				servers={servers}
				selected={selected}
				onSelect={setSelected}
				inflight={inflight}
				canCreate={canManage && canCreate}
				creating={creating}
				onAddServer={onAddServer}
			/>
			<div className="min-w-0">
				{creating && newServerKey
					? (
						<div id={`section:server:${NEW_SERVER_SELECTION}`} className="scroll-mt-2">
							<CreateServerSection stores={{ settingsEditor: newServerKey }} onCancel={onCancelCreate} />
						</div>
					)
					: selectedServer && serverKey
					? (
						<div id={`section:server:${selectedServer.id}`} className="scroll-mt-2">
							<ServerSettingsSection
								server={selectedServer}
								stores={{ settingsEditor: serverKey }}
								lifecycle={
									<ServerLifecycleControls
										server={selectedServer}
										state={lifecycleState(selectedServer, inflight)}
										busy={busy}
										canManage={canManage}
										canDelete={!deleteServersDenied}
										onToggle={() =>
											selectedServer.enabled
												? disableMutation.mutate({ serverId: selectedServer.id })
												: enableMutation.mutate({ serverId: selectedServer.id })}
										onSetDefault={() => setDefaultMutation.mutate({ serverId: selectedServer.id })}
										onDelete={() => handleDelete(selectedServer)}
									/>
								}
							/>
						</div>
					)
					: <p className="text-sm text-muted-foreground">Select a server to configure it.</p>}
			</div>
		</div>
	)
}

function ServerList(
	{ servers, selected, onSelect, inflight, canCreate, creating, onAddServer }: {
		servers: PublicServer[]
		selected: string | null
		onSelect: (id: string) => void
		inflight: { startingId?: string; stoppingId?: string }
		canCreate: boolean
		creating: boolean
		onAddServer: () => void
	},
) {
	return (
		<div className="sticky top-2 self-start space-y-2">
			<div className="space-y-1">
				{servers.length === 0 && <p className="text-sm text-muted-foreground">No servers configured.</p>}
				{servers.map((server) => (
					<button
						key={server.id}
						type="button"
						onClick={() => onSelect(server.id)}
						className={cn(
							'flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left',
							server.id === selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/50',
						)}
					>
						<span className="flex items-center justify-between gap-2">
							<span className="truncate text-sm font-medium">{server.displayName}</span>
							<ServerStatusBadge state={lifecycleState(server, inflight)} />
						</span>
						<span className="truncate font-mono text-xs text-muted-foreground">{server.id}</span>
					</button>
				))}
			</div>
			{canCreate && (
				<Button variant="outline" size="sm" className="w-full" disabled={creating} onClick={onAddServer}>
					<Icons.Plus className="mr-1 h-4 w-4" />
					Add Server
				</Button>
			)}
		</div>
	)
}

// the selected server's lifecycle controls, shown on the right of its detail-card header
function ServerLifecycleControls(
	{ server, state, busy, canManage, canDelete, onToggle, onSetDefault, onDelete }: {
		server: PublicServer
		state: ServerLifecycleState
		busy: boolean
		canManage: boolean
		canDelete: boolean
		onToggle: () => void
		onSetDefault: () => void
		onDelete: () => void
	},
) {
	return (
		<div className="flex items-center gap-2">
			<ServerStatusBadge state={state} />
			{canManage && (
				<>
					<div className="flex items-center gap-1.5">
						<Checkbox
							id={`default-${server.id}`}
							checked={server.defaultServer}
							disabled={busy || server.defaultServer}
							onCheckedChange={(checked) => checked && onSetDefault()}
						/>
						<Label htmlFor={`default-${server.id}`} className="text-sm font-normal cursor-pointer">Default</Label>
					</div>
					{!server.broken && (
						<Button
							size="sm"
							variant={server.enabled ? 'destructive' : 'outline'}
							className="w-28"
							disabled={busy}
							title={server.enabled
								? 'Disconnect from the server. It stays disconnected across SLM restarts.'
								: 'Connect to the server. It will also connect automatically with SLM.'}
							onClick={onToggle}
						>
							{server.enabled ? 'Disconnect' : 'Connect'}
						</Button>
					)}
					{canDelete && (
						<Button size="icon" variant="ghost" disabled={busy} title="Delete server" onClick={onDelete}>
							<Icons.Trash2 className="h-4 w-4" />
						</Button>
					)}
				</>
			)}
		</div>
	)
}

// GUI/JSON editor for one server's full settings (the right-hand detail of the servers master-detail). GUI mode routes
// save/reset through the shared bottom panel; JSON mode keeps its own inline toolbar (a power-user escape hatch). Server
// settings have no codec transforms, so the edit/input shape equals the stored shape (no encode step). All editing state
// lives in the section's settings-editor frame; this component is a view over it. `lifecycle` renders the server's
// start/stop/status/default/delete controls on the right of the header.
function ServerSettingsSection(
	{ server, stores, lifecycle }: {
		server: { id: string; displayName: string; broken: boolean }
		stores: SettingsEditorFrame.KeyProp
		lifecycle?: React.ReactNode
	},
) {
	const key = stores.settingsEditor
	const access = RbacClient.useServerSettingsAccess(server.id)
	const perms = RbacClient.useLoggedInPerms()
	const state = ZusUtils.useStore(key, (s: SettingsEditorFrame.SettingsEditor) => s)
	const { mode, changes, issues, valid, saving, loadFailed, loading, draft, saved } = state
	// without write-sensitive the server redacts connections, so edit/validate against the connections-free schema
	const schema = SettingsEditorFrame.Sel.schema(state)

	const value$ = React.useMemo(() => SettingsEditorFrame.draftValueState(key), [key])
	const reset$ = state.reset$
	const onFormChange = React.useCallback((v: any) => SettingsEditorFrame.Actions.setDraft({ settingsEditor: key }, v), [key])
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)
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
		const result = await openDialog({
			title: `Save ${server.displayName} settings?`,
			content: <SettingsChangeList changes={changes} />,
			buttons: [{ id: 'save', label: 'Save' }],
		})
		if (result === 'save') void SettingsEditorFrame.Actions.save({ settingsEditor: key })
	}

	function switchMode(next: 'gui' | 'json') {
		SettingsEditorFrame.Actions.setMode({ settingsEditor: key }, next)
	}

	const ready = !loadFailed && !loading && draft !== undefined

	return (
		<Card>
			<StickyGroup stickyRef={headerRef}>
				<CardHeader ref={headerRef} className="rounded-t-xl border-b bg-card">
					<div className="flex items-center justify-between gap-2">
						<div>
							<CardTitle className="flex items-center gap-2">
								{server.displayName}
								{access.write.kind === 'none' && (
									<span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">Read-only</span>
								)}
							</CardTitle>
							<CardDescription>
								<span className="font-mono">{server.id}</span>
								{server.broken && <span className="ml-2 text-destructive">Settings failed validation and need repair</span>}
							</CardDescription>
							{access.write.kind === 'paths' && (
								<p className="text-xs text-muted-foreground">
									You can only modify: {access.write.paths.map((p) => <code key={p} className="mx-0.5">{p}</code>)}
								</p>
							)}
						</div>
						<div className="flex items-center gap-3">
							{lifecycle}
							<div className="flex items-center rounded-md border p-0.5">
								<Button size="sm" variant={mode === 'gui' ? 'secondary' : 'ghost'} onClick={() => switchMode('gui')}>GUI</Button>
								<Button size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} onClick={() => switchMode('json')}>JSON</Button>
							</div>
						</div>
					</div>
				</CardHeader>
				{/* pt-3 keeps the first group's anchor-highlight ring clear of the sticky header */}
				<CardContent className="space-y-4 pt-3">
					{loadFailed
						? <p className="text-sm text-destructive">Failed to load settings: {loadFailed}</p>
						: !ready
						? <p className="text-sm text-muted-foreground">Loading…</p>
						: mode === 'gui'
						? (
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
						)
						: (
							<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
								<SchemaJsonEditor
									ref={editorRef}
									schema={schema}
									value={draft}
									onValidChange={(v: any) => SettingsEditorFrame.Actions.setJsonValid({ settingsEditor: key }, v)}
									minHeightPx={350}
									label="Server Settings"
									toolbar={
										<JsonEditorToolbar
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
	const state = ZusUtils.useStore(key, (s: SettingsEditorFrame.SettingsEditor) => s)
	const { mode, draft, issues, newId, newDisplayName } = state

	const value$ = React.useMemo(() => SettingsEditorFrame.draftValueState(key), [key])
	const reset$ = state.reset$
	const onFormChange = React.useCallback((v: any) => SettingsEditorFrame.Actions.setDraft({ settingsEditor: key }, v), [key])
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)
	const headerRef = React.useRef<HTMLDivElement>(null)

	const idRes = SS.ServerIdSchema.safeParse(newId)

	return (
		<Card>
			<StickyGroup stickyRef={headerRef}>
				<CardHeader ref={headerRef} className="rounded-t-xl border-b bg-card">
					<div className="flex items-center justify-between gap-2">
						<div>
							<CardTitle>New Server</CardTitle>
							<CardDescription>Configure a new server. Save from the panel below, or cancel.</CardDescription>
						</div>
						<div className="flex items-center gap-2">
							<div className="flex items-center rounded-md border p-0.5">
								<Button
									size="sm"
									variant={mode === 'gui' ? 'secondary' : 'ghost'}
									onClick={() => SettingsEditorFrame.Actions.setMode({ settingsEditor: key }, 'gui')}
								>
									GUI
								</Button>
								<Button
									size="sm"
									variant={mode === 'json' ? 'secondary' : 'ghost'}
									onClick={() => SettingsEditorFrame.Actions.setMode({ settingsEditor: key }, 'json')}
								>
									JSON
								</Button>
							</div>
							<Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4 pt-3">
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<LabeledInput
								label="Server ID"
								placeholder="my-server-1"
								defaultValue={newId}
								onChange={(e) => SettingsEditorFrame.Actions.setNewServerFields({ settingsEditor: key }, { id: e.target.value })}
							/>
							{newId.length > 0 && !idRes.success && <p className="text-xs text-destructive">Invalid server id</p>}
						</div>
						<LabeledInput
							label="Display Name"
							placeholder="My Squad Server"
							defaultValue={newDisplayName}
							onChange={(e) => SettingsEditorFrame.Actions.setNewServerFields({ settingsEditor: key }, { displayName: e.target.value })}
						/>
					</div>
					{mode === 'gui'
						? (
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
						)
						: (
							<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
								<SchemaJsonEditor
									ref={editorRef}
									schema={SETTINGS.ServerSettingsSchema}
									value={draft}
									onValidChange={(v: any) => SettingsEditorFrame.Actions.setJsonValid({ settingsEditor: key }, v)}
									minHeightPx={350}
									label="Server Settings"
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
	const perms = RbacClient.useLoggedInPerms()
	const state = ZusUtils.useStore(key, (s: SettingsEditorFrame.SettingsEditor) => s)
	const { mode, changes, issues, valid, saving, draft, saved, denied } = state

	const value$ = React.useMemo(() => SettingsEditorFrame.draftValueState(key), [key])
	const reset$ = state.reset$
	const onFormChange = React.useCallback((v: any) => SettingsEditorFrame.Actions.setDraft({ settingsEditor: key }, v), [key])
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)
	// the card header pins to the top of the scroll column; the form's section headers stack beneath it
	const cardHeaderRef = React.useRef<HTMLDivElement>(null)
	const openDialog = useAlertDialog()

	// mirror of the server-side grant check so out-of-grant edits surface before save
	const deniedPaths = SettingsEditorFrame.deniedSettingPaths(state, perms)

	if (denied) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Global Settings</CardTitle>
					<CardDescription>You don't have permission to view global settings.</CardDescription>
				</CardHeader>
			</Card>
		)
	}

	if (saved === undefined || draft === undefined) return null

	async function handleJsonSave() {
		if (!valid) return
		const result = await openDialog({
			title: 'Save global settings?',
			content: <SettingsChangeList changes={changes} />,
			buttons: [{ id: 'save', label: 'Save' }],
		})
		if (result === 'save') void SettingsEditorFrame.Actions.save({ settingsEditor: key })
	}

	function switchMode(next: 'gui' | 'json') {
		SettingsEditorFrame.Actions.setMode({ settingsEditor: key }, next)
	}

	return (
		<Card>
			<StickyGroup stickyRef={cardHeaderRef}>
				<CardHeader ref={cardHeaderRef} className="rounded-t-xl border-b bg-card">
					<div className="flex items-center justify-between gap-2">
						<div>
							<CardTitle className="flex items-center gap-2">
								Global Settings
								{writeAccess.kind === 'none' && (
									<span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">Read-only</span>
								)}
							</CardTitle>
							<CardDescription>Edit the global settings for this SLM instance.</CardDescription>
							{writeAccess.kind === 'paths' && (
								<p className="text-xs text-muted-foreground">
									You can only modify: {writeAccess.paths.map((p) => <code key={p} className="mx-0.5">{p}</code>)}
								</p>
							)}
						</div>
						<div className="flex items-center rounded-md border p-0.5">
							<Button size="sm" variant={mode === 'gui' ? 'secondary' : 'ghost'} onClick={() => switchMode('gui')}>GUI</Button>
							<Button size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} onClick={() => switchMode('json')}>JSON</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4 pt-3">
					{mode === 'gui'
						? (
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
						)
						: (
							// GUI mode uses the shared bottom control panel; JSON mode keeps its own toolbar, inside the editor
							<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
								<SchemaJsonEditor
									ref={editorRef}
									schema={SETTINGS.GlobalSettingsSchema}
									value={draft}
									onValidChange={(v: any) => SettingsEditorFrame.Actions.setJsonValid({ settingsEditor: key }, v)}
									minHeightPx={450}
									label="Global Settings"
									toolbar={
										<JsonEditorToolbar
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
