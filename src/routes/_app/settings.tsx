import type SchemaJsonEditorComponent from '@/components/schema-json-editor'
import type { SchemaJsonEditorHandle } from '@/components/schema-json-editor.types'
import SettingsForm from '@/components/settings-form'
import { SettingsChangeList, SettingsSavePanel } from '@/components/settings-save-panel'
import SettingsToc from '@/components/settings-toc'
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
import { GLOBAL_SETTINGS_GROUPS } from '@/lib/settings-groups'
import * as SettingsNav from '@/lib/settings-nav'
import { assertNever } from '@/lib/type-guards'
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
		<div className="flex gap-4 w-full max-w-[84rem] mx-auto h-[calc(100dvh-6rem)]">
			<aside className="w-60 shrink-0 overflow-hidden border-r pr-2 py-2">
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
			{/* no top padding: sticky section headers pin flush to the top, otherwise scrolled content bleeds into the gap */}
			<main className="flex-1 min-w-0 overflow-y-auto px-2 pb-2 space-y-6">
				{/* ServerManagement reads PublicSettingsStore, not globalSettings$, so it must not sit behind the global-settings Suspense */}
				{!manageServersDenied && (
					<div id="section:servers" className="scroll-mt-2 rounded-xl">
						<ServerManagementSection
							onAddServer={() => setCreatingNonce(createId(4))}
							creating={creating}
							canCreate={canCreateServers}
						/>
					</div>
				)}
				{servers.map((server) => {
					const key = sectionKeys.find((k) => k.kind === 'server' && k.serverId === server.id)
					if (!key) return null
					return (
						<div key={server.id} id={`section:server:${server.id}`} className="scroll-mt-2 rounded-xl">
							<ServerSettingsSection server={server} stores={{ settingsEditor: key }} />
						</div>
					)
				})}
				{!manageServersDenied && canCreateServers && creating && (() => {
					const key = sectionKeys.find((k) => k.kind === 'new-server')
					if (!key) return null
					return (
						<div id="section:server:__new__" className="scroll-mt-2 rounded-xl">
							<CreateServerSection stores={{ settingsEditor: key }} onCancel={() => setCreatingNonce(null)} />
						</div>
					)
				})()}
				{globalAccess.canRead && (() => {
					const key = sectionKeys.find((k) => k.kind === 'global')
					if (!key) return null
					return (
						<ReactRx.Subscribe
							source$={SettingsClient.globalSettings$}
							fallback={<p className="text-sm text-muted-foreground">Loading global settings…</p>}
						>
							<div id="section:global" className="scroll-mt-2 rounded-xl">
								<GlobalSettingsSection stores={{ settingsEditor: key }} />
							</div>
							<div id="section:audit" className="scroll-mt-2 rounded-xl">
								<AuditLogSection />
							</div>
						</ReactRx.Subscribe>
					)
				})()}
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
					Running
				</span>
			)
		case 'stopped':
			return (
				<span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
					<span className="h-2 w-2 rounded-full border border-muted-foreground/60" />
					Stopped
				</span>
			)
		case 'starting':
		case 'stopping':
			return (
				<span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
					<Spinner className="size-3" />
					{state === 'starting' ? 'Starting…' : 'Stopping…'}
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

function ServerManagementSection(
	{ onAddServer, creating, canCreate }: { onAddServer: () => void; creating: boolean; canCreate: boolean },
) {
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const deleteServersDenied = RbacClient.usePermsCheck(RBAC.perm('admin:delete-servers'))
	const openDialog = useAlertDialog()
	const headerRef = React.useRef<HTMLDivElement>(null)

	const enableMutation = useMutation(RPC.orpc.settings.admin.enableServer.mutationOptions({
		onSuccess: (res) => {
			if (res?.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
		},
	}))

	const disableMutation = useMutation(RPC.orpc.settings.admin.disableServer.mutationOptions({
		onSuccess: (res) => {
			if (res?.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
		},
	}))

	const deleteMutation = useMutation(RPC.orpc.settings.admin.deleteServer.mutationOptions({
		onSuccess: (res) => {
			if (res?.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
		},
	}))

	const setDefaultMutation = useMutation(RPC.orpc.settings.admin.setDefaultServer.mutationOptions({
		onSuccess: (res) => {
			if (res?.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
		},
	}))

	async function handleDelete(server: { id: string; displayName: string }) {
		const result = await openDialog({
			title: 'Delete Server',
			description: `Delete server "${server.displayName}" (${server.id})? This cannot be undone.`,
			buttons: [{ id: 'confirm', label: 'Delete', variant: 'destructive' }],
		})
		if (result !== 'confirm') return
		deleteMutation.mutate({ serverId: server.id })
	}

	const servers = settings?.servers ?? []
	const busy = enableMutation.isPending || disableMutation.isPending || deleteMutation.isPending || setDefaultMutation.isPending

	return (
		<Card>
			<StickyGroup stickyRef={headerRef}>
				<CardHeader ref={headerRef} className="rounded-t-xl border-b bg-card">
					<CardTitle>Servers</CardTitle>
					<CardDescription>Add, remove, and configure servers.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{servers.length === 0 && <p className="text-sm text-muted-foreground">No servers configured.</p>}
					{servers.map(server => {
						// the start/stop RPCs only resolve once the server slice is fully spun up / torn down, so the
						// mutation's in-flight window is exactly the transitional period
						const starting = enableMutation.isPending && enableMutation.variables?.serverId === server.id
						const stopping = disableMutation.isPending && disableMutation.variables?.serverId === server.id
						const state: ServerLifecycleState = server.broken
							? 'broken'
							: starting
							? 'starting'
							: stopping
							? 'stopping'
							: server.enabled
							? 'running'
							: 'stopped'
						return (
							<div key={server.id} className="space-y-2">
								<div className="flex items-center justify-between gap-2">
									<div>
										<p className="flex items-center gap-2 font-medium text-sm">
											{server.displayName}
											<ServerStatusBadge state={state} />
										</p>
										<p className="text-xs text-muted-foreground">{server.id}</p>
										{server.broken && <p className="text-xs text-destructive">Settings failed validation and need to be repaired</p>}
									</div>
									<div className="flex items-center gap-2">
										{server.broken
											? (
												<Button
													size="sm"
													variant="destructive"
													onClick={() => SettingsNav.navigateToAnchor(`section:server:${server.id}`)}
												>
													Fix Settings
												</Button>
											)
											: (
												<Button
													size="icon"
													variant="ghost"
													title="Edit settings"
													onClick={() => SettingsNav.navigateToAnchor(`section:server:${server.id}`)}
												>
													<Icons.Pencil className="h-4 w-4" />
												</Button>
											)}
										<div className="flex items-center gap-1.5">
											<Checkbox
												id={`default-${server.id}`}
												checked={server.defaultServer}
												disabled={busy || server.defaultServer}
												onCheckedChange={(checked) => {
													if (checked) setDefaultMutation.mutate({ serverId: server.id })
												}}
											/>
											<Label htmlFor={`default-${server.id}`} className="text-sm font-normal cursor-pointer">
												Default
											</Label>
										</div>
										{!server.broken && (
											<Button
												size="sm"
												variant="outline"
												className="w-16"
												disabled={busy}
												title={server.enabled
													? 'Stop the server. It stays off across SLM restarts.'
													: 'Start the server. It will also start automatically with SLM.'}
												onClick={() => {
													if (server.enabled) disableMutation.mutate({ serverId: server.id })
													else enableMutation.mutate({ serverId: server.id })
												}}
											>
												{server.enabled ? 'Stop' : 'Start'}
											</Button>
										)}
										{!deleteServersDenied && (
											<Button size="icon" variant="ghost" disabled={busy} onClick={() => handleDelete(server)}>
												<Icons.Trash2 className="h-4 w-4" />
											</Button>
										)}
									</div>
								</div>
							</div>
						)
					})}
					{canCreate && <Button variant="outline" disabled={creating} onClick={onAddServer}>Add Server</Button>}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}

// GUI/JSON editor for one server's full settings, always mounted so the TOC + scroll-spy can resolve its anchors. GUI
// mode routes save/reset through the shared bottom panel; JSON mode keeps its own inline toolbar (a power-user escape
// hatch). Server settings have no codec transforms, so the edit/input shape equals the stored shape (no encode step).
// All editing state lives in the section's settings-editor frame; this component is a view over it.
function ServerSettingsSection(
	{ server, stores }: {
		server: { id: string; displayName: string; broken: boolean }
		stores: SettingsEditorFrame.KeyProp
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
						<div className="flex items-center rounded-md border p-0.5">
							<Button size="sm" variant={mode === 'gui' ? 'secondary' : 'ghost'} onClick={() => switchMode('gui')}>GUI</Button>
							<Button size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} onClick={() => switchMode('json')}>JSON</Button>
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
								/>
							</React.Suspense>
						)}
					{ready && mode === 'json' && (
						<div className="flex items-center justify-end gap-2">
							{deniedPaths.length > 0 && (
								<p className="mr-auto text-xs text-amber-500">
									Not permitted to modify: {deniedPaths.map((p) => <code key={p} className="mx-0.5">{p}</code>)}
								</p>
							)}
							<Button variant="outline" onClick={() => editorRef.current?.format()}>
								<Icons.Braces className="h-4 w-4" />
								Format
							</Button>
							<Button variant="outline" onClick={() => editorRef.current?.reset()}>Reset</Button>
							<Button
								disabled={changes.length === 0 || !valid || deniedPaths.length > 0 || saving}
								onClick={handleJsonSave}
							>
								{saving ? 'Saving…' : 'Save'}
							</Button>
						</div>
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
								issues={issues}
								writeAccess={writeAccess}
							/>
						)
						: (
							<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
								<SchemaJsonEditor
									ref={editorRef}
									schema={SETTINGS.GlobalSettingsSchema}
									value={draft}
									onValidChange={(v: any) => SettingsEditorFrame.Actions.setJsonValid({ settingsEditor: key }, v)}
									minHeightPx={450}
									label="Global Settings"
								/>
							</React.Suspense>
						)}
					{/* GUI mode uses the shared bottom control panel; JSON mode keeps an inline toolbar */}
					{mode === 'json' && (
						<div className="flex items-center justify-end gap-2">
							{deniedPaths.length > 0 && (
								<p className="mr-auto text-xs text-amber-500">
									Not permitted to modify: {deniedPaths.map((p) => <code key={p} className="mx-0.5">{p}</code>)}
								</p>
							)}
							<Button variant="outline" onClick={() => editorRef.current?.format()}>
								<Icons.Braces className="h-4 w-4" />
								Format
							</Button>
							<Button variant="outline" onClick={() => editorRef.current?.reset()}>Reset</Button>
							<Button
								disabled={changes.length === 0 || !valid || deniedPaths.length > 0 || saving}
								onClick={handleJsonSave}
							>
								{saving ? 'Saving…' : 'Save'}
							</Button>
						</div>
					)}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}
