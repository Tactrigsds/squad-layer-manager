import SchemaJsonEditor, { type SchemaJsonEditorHandle } from '@/components/schema-json-editor'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAlertDialog } from '@/components/ui/lazy-alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { globalToast$ } from '@/hooks/use-global-toast'
import * as Obj from '@/lib/object'
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

export const Route = createFileRoute('/_app/settings')({
	component: RouteComponent,
})

function RouteComponent() {
	const manageServersDenied = RbacClient.usePermsCheck(RBAC.perm('admin:manage-servers'))
	const manageGlobalDenied = RbacClient.usePermsCheck(RBAC.perm('admin:manage-global-settings'))

	if (manageServersDenied && manageGlobalDenied) {
		return (
			<div className="w-full h-full grid place-items-center">
				<p className="text-muted-foreground">You don't have permission to access settings.</p>
			</div>
		)
	}

	return (
		<div className="w-full max-w-[67rem] mx-auto py-6 space-y-6">
			<ReactRx.Subscribe source$={SettingsClient.globalSettings$}>
				{!manageServersDenied && <ServerManagementSection />}
				{!manageGlobalDenied && <GlobalSettingsSection />}
			</ReactRx.Subscribe>
			{!manageGlobalDenied && <AuditLogSection />}
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
				globalToast$.next({ variant: 'destructive', title: 'Invalid settings', description: res.message })
			} else if (res.code === 'err:server-not-found') {
				globalToast$.next({ variant: 'destructive', title: 'Server not found' })
			} else if (res.code === 'ok') {
				globalToast$.next({ variant: 'default', title: 'Server settings saved' })
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
					<SchemaJsonEditor
						ref={editorRef}
						schema={SETTINGS.ServerSettingsSchema}
						value={data!.settings as SETTINGS.ServerSettings}
						onValidChange={setValidDraft}
						minHeightPx={350}
						label="Server Settings"
					/>
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
				globalToast$.next({ variant: 'destructive', title: 'A server with that ID already exists' })
			} else if (res.code === 'err:invalid-settings') {
				globalToast$.next({ variant: 'destructive', title: 'Invalid settings', description: res.message })
			} else if (res.code === 'ok') {
				globalToast$.next({ variant: 'default', title: 'Server created' })
				onDone()
			}
		},
	}))

	function handleCreate() {
		const permsRes = z.array(SM.PLAYER_PERM).safeParse(
			adminIdentifyingPermissions.split(',').map(s => s.trim()).filter(Boolean),
		)
		if (!permsRes.success) {
			globalToast$.next({
				variant: 'destructive',
				title: 'Invalid admin identifying permissions',
				description: z.prettifyError(permsRes.error),
			})
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

function GlobalSettingsSection() {
	const settings = SettingsClient.useGlobalSettings()
	const [validDraft, setValidDraft] = React.useState<SETTINGS.GlobalSettings | null>(() => {
		const res = SETTINGS.GlobalSettingsSchema.safeParse(settings)
		return res.success ? res.data : null
	})
	const editorRef = React.useRef<SchemaJsonEditorHandle>(null)

	const saveMutation = useMutation(RPC.orpc.settings.global.updateSettings.mutationOptions({
		onSuccess: (res) => {
			if (!res) return
			if (res.code === 'err:permission-denied') {
				RbacClient.handlePermissionDenied(res)
			} else if (res.code === 'err:invalid-settings') {
				globalToast$.next({ variant: 'destructive', title: 'Invalid settings', description: res.message })
			} else if (res.code === 'ok') {
				globalToast$.next({ variant: 'default', title: 'Settings saved' })
			}
		},
	}))

	if (!settings) return null

	const parsedSettingsRes = SETTINGS.GlobalSettingsSchema.safeParse(settings)
	const currentSettings = parsedSettingsRes.success ? parsedSettingsRes.data : null
	const modified = validDraft !== null && !Obj.deepEqual(validDraft, currentSettings)

	return (
		<Card>
			<CardHeader>
				<CardTitle>Global Settings</CardTitle>
				<CardDescription>Edit the global settings for this SLM instance.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<SchemaJsonEditor
					ref={editorRef}
					schema={SETTINGS.GlobalSettingsSchema}
					value={settings}
					onValidChange={setValidDraft}
					minHeightPx={450}
					label="Global Settings"
				/>
				<div className="flex justify-end gap-2">
					<Button variant="outline" onClick={() => editorRef.current?.format()}>
						<Icons.Braces className="h-4 w-4" />
						Format
					</Button>
					<Button variant="outline" onClick={() => editorRef.current?.reset()}>
						Reset
					</Button>
					<Button
						disabled={!modified || saveMutation.isPending}
						onClick={() => saveMutation.mutate(validDraft!)}
					>
						{saveMutation.isPending ? 'Saving…' : 'Save'}
					</Button>
				</div>
			</CardContent>
		</Card>
	)
}
