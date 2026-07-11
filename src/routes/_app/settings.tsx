import type SchemaJsonEditorComponent from '@/components/schema-json-editor'
import type { SchemaJsonEditorHandle } from '@/components/schema-json-editor.types'
import SettingsForm from '@/components/settings-form'
import type { SettingsEditorStore } from '@/components/settings-save-panel'
import { createSettingsEditorStore, SettingsChangeList, SettingsSavePanel, useRegisterSettingsSection } from '@/components/settings-save-panel'
import SettingsToc from '@/components/settings-toc'
import { StickyGroup } from '@/components/sticky-group'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import { Switch } from '@/components/ui/switch'
import * as Obj from '@/lib/object'
import { useRefConstructor } from '@/lib/react'
import { diffSettings } from '@/lib/settings-diff'
import { GLOBAL_SETTINGS_GROUPS } from '@/lib/settings-groups'
import * as SettingsNav from '@/lib/settings-nav'
import { toast } from '@/lib/toast'
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
import { createFileRoute } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Rx from 'rxjs'

// stable empty-issues reference so sections without validation errors don't churn the form's ValidationContext
const NO_ISSUES: never[] = []

// subscribe a component to a BehaviorSubject-like state observable (mirrors it into render state)
function useObservableValue<T>(obs$: Rx.Observable<T> & { getValue: () => T }): T {
	const [v, setV] = React.useState<T>(() => obs$.getValue())
	React.useEffect(() => {
		const sub = obs$.subscribe(setV)
		return () => sub.unsubscribe()
	}, [obs$])
	return v
}

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
	const manageGlobalDenied = RbacClient.usePermsCheck(RBAC.perm('admin:manage-global-settings'))
	// lifted so the TOC can drop the field subtree in JSON mode (those anchors only exist in the GUI editor)
	const [globalMode, setGlobalMode] = React.useState<'gui' | 'json'>('gui')
	// per-server GUI/JSON mode (default gui), lifted so the TOC drops a server's subtree while it's in JSON mode
	const [serverModes, setServerModes] = React.useState<Record<string, 'gui' | 'json'>>({})
	const [creating, setCreating] = React.useState(false)
	const [newServerMode, setNewServerMode] = React.useState<'gui' | 'json'>('gui')
	const setServerMode = React.useCallback((id: string, mode: 'gui' | 'json') => setServerModes((m) => ({ ...m, [id]: mode })), [])

	// one shared Save/Reset controller for every editable section on the page (global + each server + new server)
	const editorStore = useRefConstructor(() => createSettingsEditorStore()).current

	const publicSettings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const servers = manageServersDenied ? [] : (publicSettings?.servers ?? [])

	// scroll to the URL fragment on load (retrying until the target renders, since the form loads async) and on later
	// hash changes (a pasted/edited link). In-app clicks use replaceState, which fires no hashchange, so no double-scroll.
	React.useEffect(() => {
		const onHash = () => {
			const id = SettingsNav.currentAnchor()
			if (id) {
				SettingsNav.scrollToAnchor(id)
				SettingsNav.highlightAnchor(id)
			}
		}
		window.addEventListener('hashchange', onHash)
		const id = SettingsNav.currentAnchor()
		let raf = 0
		if (id) {
			let tries = 0
			const attempt = () => {
				if (document.getElementById(id)) {
					SettingsNav.scrollToAnchor(id)
					SettingsNav.highlightAnchor(id)
				} else if (tries++ < 90) raf = requestAnimationFrame(attempt)
			}
			raf = requestAnimationFrame(attempt)
		}
		return () => {
			window.removeEventListener('hashchange', onHash)
			if (raf) cancelAnimationFrame(raf)
		}
	}, [])

	// when the user clicks "Add Server", scroll the new-server config into view once it mounts (the section renders on
	// the next frame). Existing servers scroll via the pencil/Fix buttons in the management card.
	React.useEffect(() => {
		if (!creating) return
		let raf = 0
		let tries = 0
		const attempt = () => {
			if (document.getElementById('section:server:__new__')) SettingsNav.scrollToAnchor('section:server:__new__')
			else if (tries++ < 60) raf = requestAnimationFrame(attempt)
		}
		raf = requestAnimationFrame(attempt)
		return () => {
			if (raf) cancelAnimationFrame(raf)
		}
	}, [creating])

	if (manageServersDenied && manageGlobalDenied) {
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
					showServers={!manageServersDenied}
					showGlobal={!manageGlobalDenied}
					globalMode={globalMode}
					servers={servers}
					serverModes={serverModes}
					creatingServer={creating}
					newServerMode={newServerMode}
				/>
			</aside>
			{/* no top padding: sticky section headers pin flush to the top, otherwise scrolled content bleeds into the gap */}
			<main className="flex-1 min-w-0 overflow-y-auto px-2 pb-2 space-y-6">
				{/* ServerManagement reads PublicSettingsStore, not globalSettings$, so it must not sit behind the global-settings Suspense */}
				{!manageServersDenied && (
					<>
						<div id="section:servers" className="scroll-mt-2 rounded-xl">
							<ServerManagementSection onAddServer={() => setCreating(true)} creating={creating} />
						</div>
						{servers.map((server) => (
							<div key={server.id} id={`section:server:${server.id}`} className="scroll-mt-2 rounded-xl">
								<ServerSettingsSection
									server={server}
									editorStore={editorStore}
									mode={serverModes[server.id] ?? 'gui'}
									onModeChange={(m) => setServerMode(server.id, m)}
								/>
							</div>
						))}
						{creating && (
							<div id="section:server:__new__" className="scroll-mt-2 rounded-xl">
								<CreateServerSection
									editorStore={editorStore}
									mode={newServerMode}
									onModeChange={setNewServerMode}
									onDone={() => setCreating(false)}
								/>
							</div>
						)}
					</>
				)}
				{!manageGlobalDenied && (
					<ReactRx.Subscribe
						source$={SettingsClient.globalSettings$}
						fallback={<p className="text-sm text-muted-foreground">Loading global settings…</p>}
					>
						<div id="section:global" className="scroll-mt-2 rounded-xl">
							<GlobalSettingsSection editorStore={editorStore} mode={globalMode} onModeChange={setGlobalMode} />
						</div>
						<div id="section:audit" className="scroll-mt-2 rounded-xl">
							<AuditLogSection />
						</div>
					</ReactRx.Subscribe>
				)}
			</main>
			<SettingsSavePanel store={editorStore} />
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
								{events.map(e => (
									<div key={e.id} className="flex gap-2 items-baseline text-sm border-b py-1 last:border-0">
										<span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
											{new Date(e.time).toLocaleString()}
										</span>
										<span className="font-medium whitespace-nowrap">{actorName(e.actor)}</span>
										<span className="text-muted-foreground grow min-w-0 wrap-break-word">{AppEvents.describeAppEvent(e)}</span>
										{e.serverId && <span className="text-xs text-muted-foreground whitespace-nowrap">{e.serverId}</span>}
									</div>
								))}
							</div>
						)}
				</CardContent>
			</StickyGroup>
		</Card>
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

function ServerManagementSection({ onAddServer, creating }: { onAddServer: () => void; creating: boolean }) {
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
					{servers.map(server => (
						<div key={server.id} className="space-y-2">
							<div className="flex items-center justify-between gap-2">
								<div>
									<p className="font-medium text-sm">{server.displayName}</p>
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
									<Switch
										checked={server.enabled}
										disabled={busy || server.broken}
										onCheckedChange={(checked) => {
											if (checked) enableMutation.mutate({ serverId: server.id })
											else disableMutation.mutate({ serverId: server.id })
										}}
									/>
									{!deleteServersDenied && (
										<Button size="icon" variant="ghost" disabled={busy} onClick={() => handleDelete(server)}>
											<Icons.Trash2 className="h-4 w-4" />
										</Button>
									)}
								</div>
							</div>
						</div>
					))}
					<Button variant="outline" disabled={creating} onClick={onAddServer}>Add Server</Button>
				</CardContent>
			</StickyGroup>
		</Card>
	)
}

// GUI/JSON editor for one server's full settings, always mounted so the TOC + scroll-spy can resolve its anchors. GUI
// mode routes save/reset through the shared bottom panel; JSON mode keeps its own inline toolbar (a power-user escape
// hatch). Server settings have no codec transforms, so the edit/input shape equals the stored shape (no encode step).
function ServerSettingsSection(
	{ server, editorStore, mode, onModeChange }: {
		server: { id: string; displayName: string; broken: boolean }
		editorStore: SettingsEditorStore
		mode: 'gui' | 'json'
		onModeChange: (mode: 'gui' | 'json') => void
	},
) {
	const { data, isLoading } = useQuery(RPC.orpc.settings.admin.getRawSettings.queryOptions({ input: { serverId: server.id } }))
	const loadFailed = data && data.code !== 'ok' ? data.code : null
	const initial = data?.code === 'ok' ? (data.settings as SETTINGS.ServerSettings) : undefined

	const draft$ = useRefConstructor(() => new Rx.BehaviorSubject<SETTINGS.ServerSettings | undefined>(undefined)).current
	const reset$ = useRefConstructor(() => new Rx.Subject<void>()).current
	const draft = useObservableValue(draft$)
	const onFormChange = React.useCallback((v: any) => draft$.next(v), [draft$])
	const [jsonValid, setJsonValid] = React.useState<SETTINGS.ServerSettings | null>(null)
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)
	const headerRef = React.useRef<HTMLDivElement>(null)
	const openDialog = useAlertDialog()

	React.useEffect(() => {
		if (initial !== undefined && draft$.getValue() === undefined) draft$.next(initial)
	}, [initial, draft$])

	const saveMutation = useMutation(RPC.orpc.settings.admin.updateRawSettings.mutationOptions({
		onSuccess: (res) => {
			if (!res) return
			if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
			else if (res.code === 'err:invalid-settings') toast.error('Invalid settings', { description: res.message })
			else if (res.code === 'err:server-not-found') toast.error('Server not found')
			else if (res.code === 'ok') toast('Server settings saved')
		},
	}))

	const nextEnc = mode === 'gui' ? draft : (jsonValid ?? undefined)
	const changes = React.useMemo(() => (initial && nextEnc ? diffSettings(initial, nextEnc) : []), [initial, nextEnc])
	const guiRes = draft !== undefined ? SETTINGS.ServerSettingsSchema.safeParse(draft) : undefined
	const validDraft = mode === 'json' ? jsonValid : (guiRes && guiRes.success ? guiRes.data : null)
	const guiIssues = mode === 'gui' && guiRes && !guiRes.success ? guiRes.error.issues : NO_ISSUES

	const save = React.useCallback(async () => {
		const v = SETTINGS.ServerSettingsSchema.safeParse(draft$.getValue())
		if (!v.success) return
		await saveMutation.mutateAsync({ serverId: server.id, settings: v.data })
	}, [draft$, saveMutation, server.id])
	const reset = React.useCallback(() => {
		if (initial !== undefined) {
			draft$.next(initial)
			reset$.next()
		}
	}, [initial, draft$, reset$])

	useRegisterSettingsSection(editorStore, {
		key: `server:${server.id}`,
		label: server.displayName,
		changedCount: mode === 'gui' ? changes.length : 0,
		errorCount: guiIssues.length,
		valid: validDraft !== null,
		saving: saveMutation.isPending,
		getChanges: () => changes,
		save,
		reset,
	})

	function switchMode(next: 'gui' | 'json') {
		if (next === mode) return
		if (next === 'json') setJsonValid(guiRes && guiRes.success ? guiRes.data : null)
		else if (jsonValid) {
			draft$.next(jsonValid)
			reset$.next()
		}
		onModeChange(next)
	}

	async function handleJsonSave() {
		if (!validDraft) return
		const result = await openDialog({
			title: `Save ${server.displayName} settings?`,
			content: <SettingsChangeList changes={changes} />,
			buttons: [{ id: 'save', label: 'Save' }],
		})
		if (result === 'save') saveMutation.mutate({ serverId: server.id, settings: validDraft })
	}

	const ready = !loadFailed && !isLoading && draft !== undefined

	return (
		<Card>
			<StickyGroup stickyRef={headerRef}>
				<CardHeader ref={headerRef} className="rounded-t-xl border-b bg-card">
					<div className="flex items-center justify-between gap-2">
						<div>
							<CardTitle>{server.displayName}</CardTitle>
							<CardDescription>
								<span className="font-mono">{server.id}</span>
								{server.broken && <span className="ml-2 text-destructive">Settings failed validation and need repair</span>}
							</CardDescription>
						</div>
						<div className="flex items-center rounded-md border p-0.5">
							<Button size="sm" variant={mode === 'gui' ? 'secondary' : 'ghost'} onClick={() => switchMode('gui')}>GUI</Button>
							<Button size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} onClick={() => switchMode('json')}>JSON</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					{loadFailed
						? <p className="text-sm text-destructive">Failed to load settings: {loadFailed}</p>
						: !ready
						? <p className="text-sm text-muted-foreground">Loading…</p>
						: mode === 'gui'
						? (
							<SettingsForm
								schema={SETTINGS.ServerSettingsSchema}
								value$={draft$}
								reset$={reset$}
								onChange={onFormChange}
								saved={initial}
								idPrefix={`setting:server:${server.id}:`}
								issues={guiIssues}
							/>
						)
						: (
							<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
								<SchemaJsonEditor
									ref={editorRef}
									schema={SETTINGS.ServerSettingsSchema}
									value={draft}
									onValidChange={setJsonValid}
									minHeightPx={350}
									label="Server Settings"
								/>
							</React.Suspense>
						)}
					{ready && mode === 'json' && (
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => editorRef.current?.format()}>
								<Icons.Braces className="h-4 w-4" />
								Format
							</Button>
							<Button variant="outline" onClick={() => editorRef.current?.reset()}>Reset</Button>
							<Button disabled={changes.length === 0 || validDraft === null || saveMutation.isPending} onClick={handleJsonSave}>
								{saveMutation.isPending ? 'Saving…' : 'Save'}
							</Button>
						</div>
					)}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}

// minimal input-shape seed for a brand-new server: the required-without-default fields (connections + admin lists).
// prefaulted fields (queue, public settings) are filled in by ServerSettingsSchema at save time.
const NEW_SERVER_DRAFT: SETTINGS.ServerSettings = {
	connections: {
		rcon: { host: '', port: 21114, password: '' },
		logs: { type: 'log-receiver', token: 'dev' },
	},
	adminListSources: [],
	adminIdentifyingPermissions: ['canseeadminchat'],
} as unknown as SETTINGS.ServerSettings

// create a new server on the same generic form; id + displayName sit above the settings form. Registered with the
// shared panel so it saves via the one bottom control (creating the server), consistent with editing.
function CreateServerSection(
	{ editorStore, mode, onModeChange, onDone }: {
		editorStore: SettingsEditorStore
		mode: 'gui' | 'json'
		onModeChange: (mode: 'gui' | 'json') => void
		onDone: () => void
	},
) {
	const [id, setId] = React.useState('')
	const [displayName, setDisplayName] = React.useState('')
	const draft$ = useRefConstructor(() => new Rx.BehaviorSubject<SETTINGS.ServerSettings>(Obj.deepClone(NEW_SERVER_DRAFT))).current
	const reset$ = useRefConstructor(() => new Rx.Subject<void>()).current
	const draft = useObservableValue(draft$)
	const onFormChange = React.useCallback((v: any) => draft$.next(v), [draft$])
	const [jsonValid, setJsonValid] = React.useState<SETTINGS.ServerSettings | null>(Obj.deepClone(NEW_SERVER_DRAFT))
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)
	const headerRef = React.useRef<HTMLDivElement>(null)

	const createMutation = useMutation(RPC.orpc.settings.admin.createServer.mutationOptions({
		onSuccess: (res) => {
			if (!res) return
			if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
			else if (res.code === 'err:server-already-exists') toast.error('A server with that ID already exists')
			else if (res.code === 'err:invalid-settings') toast.error('Invalid settings', { description: res.message })
			else if (res.code === 'ok') {
				toast('Server created')
				onDone()
			}
		},
	}))

	const guiRes = SETTINGS.ServerSettingsSchema.safeParse(draft)
	const validSettings = mode === 'json' ? jsonValid : (guiRes.success ? guiRes.data : null)
	const guiIssues = mode === 'gui' && !guiRes.success ? guiRes.error.issues : NO_ISSUES
	const idRes = SS.ServerIdSchema.safeParse(id)
	const valid = idRes.success && displayName.trim().length > 0 && validSettings !== null

	const save = React.useCallback(async () => {
		const v = SETTINGS.ServerSettingsSchema.safeParse(draft$.getValue())
		if (!idRes.success || !displayName.trim() || !v.success) return
		await createMutation.mutateAsync({ id, displayName: displayName.trim(), settings: v.data })
	}, [draft$, idRes.success, id, displayName, createMutation])
	const reset = React.useCallback(() => {
		setId('')
		setDisplayName('')
		draft$.next(Obj.deepClone(NEW_SERVER_DRAFT))
		reset$.next()
		onDone()
	}, [draft$, reset$, onDone])

	// while the create section is mounted there's a pending new server, so it always contributes to the panel
	useRegisterSettingsSection(editorStore, {
		key: 'server:__new__',
		label: displayName.trim() || 'New Server',
		changedCount: mode === 'gui' ? 1 : 0,
		errorCount: guiIssues.length,
		valid,
		saving: createMutation.isPending,
		getChanges: () => diffSettings({}, { id, displayName, ...(validSettings ?? {}) }),
		save,
		reset,
	})

	function switchMode(next: 'gui' | 'json') {
		if (next === mode) return
		if (next === 'json') setJsonValid(guiRes.success ? guiRes.data : null)
		else if (jsonValid) {
			draft$.next(jsonValid)
			reset$.next()
		}
		onModeChange(next)
	}

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
								<Button size="sm" variant={mode === 'gui' ? 'secondary' : 'ghost'} onClick={() => switchMode('gui')}>GUI</Button>
								<Button size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} onClick={() => switchMode('json')}>JSON</Button>
							</div>
							<Button size="sm" variant="outline" onClick={reset}>Cancel</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1">
							<LabeledInput label="Server ID" placeholder="my-server-1" defaultValue={id} onChange={(e) => setId(e.target.value)} />
							{id.length > 0 && !idRes.success && <p className="text-xs text-destructive">Invalid server id</p>}
						</div>
						<LabeledInput
							label="Display Name"
							placeholder="My Squad Server"
							defaultValue={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
					</div>
					{mode === 'gui'
						? (
							<SettingsForm
								schema={SETTINGS.ServerSettingsSchema}
								value$={draft$}
								reset$={reset$}
								onChange={onFormChange}
								saved={NEW_SERVER_DRAFT}
								idPrefix="setting:server:__new__:"
								issues={guiIssues}
							/>
						)
						: (
							<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
								<SchemaJsonEditor
									ref={editorRef}
									schema={SETTINGS.ServerSettingsSchema}
									value={draft}
									onValidChange={setJsonValid}
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

function GlobalSettingsSection(
	{ editorStore, mode, onModeChange }: {
		editorStore: SettingsEditorStore
		mode: 'gui' | 'json'
		onModeChange: (mode: 'gui' | 'json') => void
	},
) {
	const raw = SettingsClient.useGlobalSettings()
	// the server denies the watch when the user lacks admin:manage-global-settings (e.g. stale perms after an rbac change)
	const denied = !!raw && typeof raw === 'object' && 'code' in raw
	const settings = denied ? undefined : (raw as SETTINGS.GlobalSettingsInput | undefined)

	// the live GUI draft, held in the encoded/input shape (same shape as `settings`). It lives in a BehaviorSubject
	// (not React state) so the form can read it via `value$.getValue()` and keep its inputs uncontrolled; edits are
	// debounced into it by the leaf fields. `reset$` tells uncontrolled fields to re-read after a structural or
	// programmatic change (reset-to-default, reset-all, mode switch).
	const draft$ = useRefConstructor(() => new Rx.BehaviorSubject<SETTINGS.GlobalSettingsInput | undefined>(settings)).current
	const reset$ = useRefConstructor(() => new Rx.Subject<void>()).current
	const draft = useObservableValue(draft$)
	const onFormChange = React.useCallback((v: SETTINGS.GlobalSettingsInput) => draft$.next(v), [draft$])
	// seed the draft if settings only became available after mount (e.g. deny recovered to granted)
	React.useEffect(() => {
		if (settings !== undefined && draft$.getValue() === undefined) draft$.next(settings)
	}, [settings, draft$])

	// the latest valid, decoded value from the JSON editor while in JSON mode
	const [jsonValid, setJsonValid] = React.useState<SETTINGS.GlobalSettings | null>(null)
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)
	// the card header pins to the top of the scroll column; the form's section headers stack beneath it
	const cardHeaderRef = React.useRef<HTMLDivElement>(null)

	// a deny here means our cached perms are stale; refetch the logged-in user so the route re-gates correctly
	React.useEffect(() => {
		if (denied) RbacClient.handlePermissionDenied(raw as RBAC.PermissionDeniedResponse)
	}, [denied, raw])

	const openDialog = useAlertDialog()
	const saveMutation = useMutation(RPC.orpc.settings.global.updateSettings.mutationOptions({
		onSuccess: (res) => {
			if (!res) return
			if (res.code === 'err:permission-denied') {
				RbacClient.handlePermissionDenied(res)
			} else if (res.code === 'err:invalid-settings') {
				toast.error('Invalid settings', { description: res.message })
			} else if (res.code === 'ok') {
				toast('Settings saved')
			}
		},
	}))

	// the pending value in the encoded/input shape (same shape as `settings`), for diffing against the current settings
	const nextEnc = React.useMemo(
		() => mode === 'gui' ? draft : (jsonValid ? SETTINGS.GlobalSettingsSchema.encode(jsonValid) : undefined),
		[mode, draft, jsonValid],
	)
	const changes = React.useMemo(
		() => (settings && nextEnc ? diffSettings(settings, nextEnc) : []),
		[settings, nextEnc],
	)

	// computed before the early returns so the register hook below always runs in the same order
	const guiRes = React.useMemo(() => (draft !== undefined ? SETTINGS.GlobalSettingsSchema.safeParse(draft) : undefined), [draft])
	const validDraft = mode === 'json' ? jsonValid : (guiRes && guiRes.success ? guiRes.data : null)
	const guiIssues = mode === 'gui' && guiRes && !guiRes.success ? guiRes.error.issues : NO_ISSUES

	const save = React.useCallback(async () => {
		const parsed = SETTINGS.GlobalSettingsSchema.safeParse(draft$.getValue())
		if (!parsed.success) return
		await saveMutation.mutateAsync(parsed.data)
	}, [draft$, saveMutation])
	const resetDraft = React.useCallback(() => {
		if (settings !== undefined) {
			draft$.next(settings)
			reset$.next()
		}
	}, [settings, draft$, reset$])

	// GUI mode routes save/reset through the shared bottom panel; JSON mode keeps its own inline toolbar
	useRegisterSettingsSection(editorStore, {
		key: 'global',
		label: 'Global Settings',
		changedCount: mode === 'gui' ? changes.length : 0,
		errorCount: guiIssues.length,
		valid: validDraft !== null,
		saving: saveMutation.isPending,
		getChanges: () => changes,
		save,
		reset: resetDraft,
	})

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

	if (!settings || draft === undefined || guiRes === undefined) return null

	async function handleJsonSave() {
		if (!validDraft) return
		const result = await openDialog({
			title: 'Save global settings?',
			content: <SettingsChangeList changes={changes} />,
			buttons: [{ id: 'save', label: 'Save' }],
		})
		if (result === 'save') saveMutation.mutate(validDraft)
	}

	function switchMode(next: 'gui' | 'json') {
		if (next === mode) return
		if (next === 'json') {
			// seed the JSON editor's notion of validity from the current gui draft
			setJsonValid(guiRes!.success ? guiRes!.data : null)
		} else if (jsonValid) {
			// carry JSON edits back into the gui draft (re-encode to the input shape); reset$ makes the gui re-read
			draft$.next(SETTINGS.GlobalSettingsSchema.encode(jsonValid))
			reset$.next()
		}
		onModeChange(next)
	}

	return (
		<Card>
			<StickyGroup stickyRef={cardHeaderRef}>
				<CardHeader ref={cardHeaderRef} className="rounded-t-xl border-b bg-card">
					<div className="flex items-center justify-between gap-2">
						<div>
							<CardTitle>Global Settings</CardTitle>
							<CardDescription>Edit the global settings for this SLM instance.</CardDescription>
						</div>
						<div className="flex items-center rounded-md border p-0.5">
							<Button size="sm" variant={mode === 'gui' ? 'secondary' : 'ghost'} onClick={() => switchMode('gui')}>GUI</Button>
							<Button size="sm" variant={mode === 'json' ? 'secondary' : 'ghost'} onClick={() => switchMode('json')}>JSON</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					{mode === 'gui'
						? (
							<SettingsForm
								schema={SETTINGS.GlobalSettingsSchema}
								value$={draft$}
								reset$={reset$}
								onChange={onFormChange}
								saved={settings}
								groups={GLOBAL_SETTINGS_GROUPS}
								issues={guiIssues}
							/>
						)
						: (
							<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
								<SchemaJsonEditor
									ref={editorRef}
									schema={SETTINGS.GlobalSettingsSchema}
									value={draft}
									onValidChange={setJsonValid}
									minHeightPx={450}
									label="Global Settings"
								/>
							</React.Suspense>
						)}
					{/* GUI mode uses the shared bottom control panel; JSON mode keeps an inline toolbar */}
					{mode === 'json' && (
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => editorRef.current?.format()}>
								<Icons.Braces className="h-4 w-4" />
								Format
							</Button>
							<Button variant="outline" onClick={() => editorRef.current?.reset()}>Reset</Button>
							<Button disabled={changes.length === 0 || validDraft === null || saveMutation.isPending} onClick={handleJsonSave}>
								{saveMutation.isPending ? 'Saving…' : 'Save'}
							</Button>
						</div>
					)}
				</CardContent>
			</StickyGroup>
		</Card>
	)
}
