import type SchemaJsonEditorComponent from '@/components/schema-json-editor'
import type { SchemaJsonEditorHandle } from '@/components/schema-json-editor.types'
import SettingsForm from '@/components/settings-form'
import SettingsToc from '@/components/settings-toc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import * as Obj from '@/lib/object'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as AppEvents from '@/models/app-events.models'
import * as SETTINGS from '@/models/settings.models'
import * as SM from '@/models/squad.models'
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
import { z } from 'zod'

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
			<aside className="w-60 shrink-0 overflow-y-auto border-r pr-2 py-2">
				<SettingsToc showServers={!manageServersDenied} showGlobal={!manageGlobalDenied} globalMode={globalMode} />
			</aside>
			<main className="flex-1 min-w-0 overflow-y-auto pr-2 py-2 space-y-6">
				{/* ServerManagement reads PublicSettingsStore, not globalSettings$, so it must not sit behind the global-settings Suspense */}
				{!manageServersDenied && (
					<div id="section:servers" className="scroll-mt-2">
						<ServerManagementSection />
					</div>
				)}
				{!manageGlobalDenied && (
					<ReactRx.Subscribe
						source$={SettingsClient.globalSettings$}
						fallback={<p className="text-sm text-muted-foreground">Loading global settings…</p>}
					>
						<div id="section:global" className="scroll-mt-2">
							<GlobalSettingsSection mode={globalMode} onModeChange={setGlobalMode} />
						</div>
						<div id="section:audit" className="scroll-mt-2">
							<AuditLogSection />
						</div>
					</ReactRx.Subscribe>
				)}
			</main>
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

	return (
		<Card>
			<CardHeader>
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

function ServerManagementSection() {
	const settings = ZusUtils.useStore(SettingsClient.PublicSettingsStore)
	const deleteServersDenied = RbacClient.usePermsCheck(RBAC.perm('admin:delete-servers'))
	const openDialog = useAlertDialog()
	const [showCreateForm, setShowCreateForm] = React.useState(false)
	const [editingServerId, setEditingServerId] = React.useState<string | null>(null)

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
			<CardHeader>
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
											onClick={() => setEditingServerId(editingServerId === server.id ? null : server.id)}
										>
											Fix Settings
										</Button>
									)
									: (
										<Button
											size="icon"
											variant="ghost"
											disabled={busy}
											onClick={() => setEditingServerId(editingServerId === server.id ? null : server.id)}
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
						{editingServerId === server.id && <RawSettingsEditor serverId={server.id} onDone={() => setEditingServerId(null)} />}
					</div>
				))}
				{showCreateForm
					? <CreateServerForm onDone={() => setShowCreateForm(false)} />
					: <Button variant="outline" onClick={() => setShowCreateForm(true)}>Add Server</Button>}
			</CardContent>
		</Card>
	)
}

function RawSettingsEditor({ serverId, onDone }: { serverId: string; onDone: () => void }) {
	const { data, isLoading } = useQuery(RPC.orpc.settings.admin.getRawSettings.queryOptions({ input: { serverId } }))
	const [validDraft, setValidDraft] = React.useState<SETTINGS.ServerSettings | null>(null)
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)

	const saveMutation = useMutation(RPC.orpc.settings.admin.updateRawSettings.mutationOptions({
		onSuccess: (res) => {
			if (!res) return
			if (res.code === 'err:permission-denied') {
				RbacClient.handlePermissionDenied(res)
			} else if (res.code === 'err:invalid-settings') {
				toast.error('Invalid settings', { description: res.message })
			} else if (res.code === 'err:server-not-found') {
				toast.error('Server not found')
			} else if (res.code === 'ok') {
				toast('Server settings saved')
				onDone()
			}
		},
	}))

	if (data && data.code !== 'ok') {
		return <p className="text-sm text-destructive">Failed to load settings: {data.code}</p>
	}

	const initialParseRes = data?.code === 'ok' ? SETTINGS.ServerSettingsSchema.safeParse(data.settings) : undefined
	const initialSettings = initialParseRes?.success ? initialParseRes.data : null
	const modified = validDraft !== null && !Obj.deepEqual(validDraft, initialSettings)

	return (
		<div className="border rounded-md p-4 space-y-3">
			<Label>Raw Settings JSON</Label>
			{isLoading
				? <p className="text-sm text-muted-foreground">Loading…</p>
				: (
					<React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading editor…</p>}>
						<SchemaJsonEditor
							ref={editorRef}
							schema={SETTINGS.ServerSettingsSchema}
							value={data!.settings as SETTINGS.ServerSettings}
							onValidChange={setValidDraft}
							minHeightPx={350}
							label="Server Settings"
						/>
					</React.Suspense>
				)}
			<div className="flex justify-end gap-2">
				<Button variant="outline" onClick={() => editorRef.current?.format()}>
					<Icons.Braces className="h-4 w-4" />
					Format
				</Button>
				<Button variant="outline" onClick={onDone}>{modified ? 'Cancel' : 'Hide'}</Button>
				<Button
					disabled={!validDraft || saveMutation.isPending}
					onClick={() => saveMutation.mutate({ serverId, settings: validDraft })}
				>
					{saveMutation.isPending ? 'Saving…' : 'Save'}
				</Button>
			</div>
		</div>
	)
}

const LOG_TYPES = ['log-receiver', 'sftp'] as const

function CreateServerForm({ onDone }: { onDone: () => void }) {
	const [id, setId] = React.useState('')
	const [displayName, setDisplayName] = React.useState('')
	const [rconHost, setRconHost] = React.useState('')
	const [rconPort, setRconPort] = React.useState('21114')
	const [rconPassword, setRconPassword] = React.useState('')
	const [logsType, setLogsType] = React.useState<typeof LOG_TYPES[number]>('log-receiver')
	const [logsToken, setLogsToken] = React.useState('')
	const [sftpHost, setSftpHost] = React.useState('')
	const [sftpPort, setSftpPort] = React.useState('8022')
	const [sftpUsername, setSftpUsername] = React.useState('')
	const [sftpPassword, setSftpPassword] = React.useState('')
	const [sftpLogFile, setSftpLogFile] = React.useState('')
	const [adminListSources, setAdminListSources] = React.useState('')
	const [adminIdentifyingPermissions, setAdminIdentifyingPermissions] = React.useState('canseeadminchat')

	const createMutation = useMutation(RPC.orpc.settings.admin.createServer.mutationOptions({
		onSuccess: (res) => {
			if (!res) return
			if (res.code === 'err:permission-denied') {
				RbacClient.handlePermissionDenied(res)
			} else if (res.code === 'err:server-already-exists') {
				toast.error('A server with that ID already exists')
			} else if (res.code === 'err:invalid-settings') {
				toast.error('Invalid settings', { description: res.message })
			} else if (res.code === 'ok') {
				toast('Server created')
				onDone()
			}
		},
	}))

	function handleCreate() {
		const permsRes = z.array(SM.PLAYER_PERM).safeParse(
			adminIdentifyingPermissions.split(',').map(s => s.trim()).filter(Boolean),
		)
		if (!permsRes.success) {
			toast.error('Invalid admin identifying permissions', { description: z.prettifyError(permsRes.error) })
			return
		}

		createMutation.mutate({
			id,
			displayName,
			connections: {
				rcon: { host: rconHost, port: Number(rconPort), password: rconPassword },
				logs: logsType === 'log-receiver'
					? { type: 'log-receiver' as const, token: logsToken || 'dev' }
					: {
						type: 'sftp' as const,
						host: sftpHost,
						port: Number(sftpPort),
						username: sftpUsername,
						password: sftpPassword,
						logFile: sftpLogFile,
					},
			},
			adminListSources: adminListSources.split(',').map(s => s.trim()).filter(Boolean),
			adminIdentifyingPermissions: permsRes.data,
		})
	}

	return (
		<div className="border rounded-md p-4 space-y-3">
			<div className="grid grid-cols-2 gap-3">
				<LabeledInput label="Server ID" value={id} onChange={e => setId(e.target.value)} />
				<LabeledInput label="Display Name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
			</div>
			<div className="grid grid-cols-3 gap-3">
				<LabeledInput label="RCON Host" value={rconHost} onChange={e => setRconHost(e.target.value)} />
				<LabeledInput label="RCON Port" value={rconPort} onChange={e => setRconPort(e.target.value)} />
				<LabeledInput
					label="RCON Password"
					type="password"
					value={rconPassword}
					onChange={e => setRconPassword(e.target.value)}
				/>
			</div>
			<div className="space-y-1">
				<Label>Log Source</Label>
				<Select value={logsType} onValueChange={v => setLogsType(v as typeof LOG_TYPES[number])}>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="log-receiver">Log Receiver</SelectItem>
						<SelectItem value="sftp">SFTP</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{logsType === 'log-receiver'
				? <LabeledInput label="Log Receiver Token" value={logsToken} onChange={e => setLogsToken(e.target.value)} />
				: (
					<div className="grid grid-cols-2 gap-3">
						<LabeledInput label="SFTP Host" value={sftpHost} onChange={e => setSftpHost(e.target.value)} />
						<LabeledInput label="SFTP Port" value={sftpPort} onChange={e => setSftpPort(e.target.value)} />
						<LabeledInput label="SFTP Username" value={sftpUsername} onChange={e => setSftpUsername(e.target.value)} />
						<LabeledInput
							label="SFTP Password"
							type="password"
							value={sftpPassword}
							onChange={e => setSftpPassword(e.target.value)}
						/>
						<LabeledInput label="SFTP Log File Path" value={sftpLogFile} onChange={e => setSftpLogFile(e.target.value)} />
					</div>
				)}
			<LabeledInput
				label="Admin List Sources (comma-separated)"
				value={adminListSources}
				onChange={e => setAdminListSources(e.target.value)}
				placeholder="e.g. main, community"
			/>
			<LabeledInput
				label="Admin Identifying Permissions (comma-separated)"
				value={adminIdentifyingPermissions}
				onChange={e => setAdminIdentifyingPermissions(e.target.value)}
			/>
			<div className="flex justify-end gap-2">
				<Button variant="outline" onClick={onDone}>Cancel</Button>
				<Button
					disabled={createMutation.isPending || !id || !displayName || !rconHost || !rconPassword}
					onClick={handleCreate}
				>
					{createMutation.isPending ? 'Creating…' : 'Create'}
				</Button>
			</div>
		</div>
	)
}

type SettingChange = { path: string; from: unknown; to: unknown }

// leaf-level diff of two settings objects (input/encoded shape) keyed by json path; objects recurse, arrays/scalars are leaves
function diffSettings(from: any, to: any, path: string[] = [], out: SettingChange[] = []): SettingChange[] {
	const isPlainObj = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v)
	if (isPlainObj(from) && isPlainObj(to)) {
		for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
			diffSettings(from[key], to[key], [...path, key], out)
		}
	} else if (!Obj.deepEqual(from, to)) {
		out.push({ path: path.join('.'), from, to })
	}
	return out
}

function formatChangeValue(v: unknown): string {
	if (v === undefined) return '(unset)'
	if (v === null) return 'null'
	if (typeof v === 'string') return v === '' ? '(empty)' : v
	if (typeof v === 'boolean' || typeof v === 'number') return String(v)
	const s = JSON.stringify(v)
	return s.length > 200 ? s.slice(0, 200) + '…' : s
}

function SettingsChangeList({ changes }: { changes: SettingChange[] }) {
	return (
		<div className="max-h-[50vh] space-y-2 overflow-y-auto text-sm">
			{changes.map((c) => (
				<div key={c.path} className="border-b pb-1.5 last:border-0">
					<code className="text-xs text-muted-foreground">{c.path}</code>
					<div className="mt-0.5 flex flex-wrap items-center gap-2">
						<span className="text-muted-foreground line-through break-all">{formatChangeValue(c.from)}</span>
						<Icons.ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
						<span className="break-all">{formatChangeValue(c.to)}</span>
					</div>
				</div>
			))}
		</div>
	)
}

function GlobalSettingsSection({ mode, onModeChange }: { mode: 'gui' | 'json'; onModeChange: (mode: 'gui' | 'json') => void }) {
	const raw = SettingsClient.useGlobalSettings()
	// the server denies the watch when the user lacks admin:manage-global-settings (e.g. stale perms after an rbac change)
	const denied = !!raw && typeof raw === 'object' && 'code' in raw
	const settings = denied ? undefined : (raw as SETTINGS.GlobalSettingsInput | undefined)

	// the live GUI draft, held in the encoded/input shape (same shape as `settings`)
	const [draft, setDraft] = React.useState<SETTINGS.GlobalSettingsInput | undefined>(settings)
	// the latest valid, decoded value from the JSON editor while in JSON mode
	const [jsonValid, setJsonValid] = React.useState<SETTINGS.GlobalSettings | null>(null)
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)

	// initialize the draft once settings first become available (set-in-render, runs once)
	if (draft === undefined && settings !== undefined) setDraft(settings)

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

	if (!settings || draft === undefined) return null

	const guiRes = SETTINGS.GlobalSettingsSchema.safeParse(draft)
	const validDraft = mode === 'json' ? jsonValid : (guiRes.success ? guiRes.data : null)
	const modified = changes.length > 0
	const canSave = modified && validDraft !== null && !saveMutation.isPending

	async function handleSave() {
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
			setJsonValid(guiRes.success ? guiRes.data : null)
		} else if (jsonValid) {
			// carry JSON edits back into the gui draft (re-encode to the input shape)
			setDraft(SETTINGS.GlobalSettingsSchema.encode(jsonValid))
		}
		onModeChange(next)
	}

	return (
		<>
			<Card>
				<CardHeader>
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
						? <SettingsForm schema={SETTINGS.GlobalSettingsSchema} value={draft} onChange={setDraft} />
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
					{/* GUI mode uses the floating control panel below; JSON mode keeps an inline toolbar */}
					{mode === 'json' && (
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => editorRef.current?.format()}>
								<Icons.Braces className="h-4 w-4" />
								Format
							</Button>
							<Button variant="outline" onClick={() => editorRef.current?.reset()}>Reset</Button>
							<Button disabled={!canSave} onClick={handleSave}>
								{saveMutation.isPending ? 'Saving…' : 'Save'}
							</Button>
						</div>
					)}
				</CardContent>
			</Card>
			{mode === 'gui' && modified && (
				<div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg">
					<span className="text-sm">
						<span className="font-medium">{changes.length}</span> {changes.length === 1 ? 'setting' : 'settings'} changed
					</span>
					<Button variant="outline" size="sm" onClick={() => setDraft(settings)}>Reset</Button>
					<Button size="sm" disabled={!canSave} onClick={handleSave}>
						{saveMutation.isPending ? 'Saving…' : 'Save'}
					</Button>
				</div>
			)}
		</>
	)
}
