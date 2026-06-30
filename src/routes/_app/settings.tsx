import { globalToast$ } from '@/hooks/use-global-toast'
import * as RBAC from '@/rbac.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import * as GlobalSettingsClient from '@/systems/global-settings.client'
import * as RbacClient from '@/systems/rbac.client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useMutation } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import React from 'react'

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
		<div className="w-full max-w-3xl mx-auto py-6 space-y-6">
			{!manageServersDenied && <ServerManagementSection />}
			{!manageGlobalDenied && <GlobalSettingsSection />}
		</div>
	)
}

function ServerManagementSection() {
	const config = ConfigClient.useConfig()

	const enableMutation = useMutation({
		mutationFn: (serverId: string) => RPC.orpc.adminSettings.enableServer.call({ serverId }),
		onSuccess: (res) => {
			if (res?.code === 'err:permission-denied') {
				RbacClient.handlePermissionDenied(res)
			}
		},
	})

	const disableMutation = useMutation({
		mutationFn: (serverId: string) => RPC.orpc.adminSettings.disableServer.call({ serverId }),
		onSuccess: (res) => {
			if (res?.code === 'err:permission-denied') {
				RbacClient.handlePermissionDenied(res)
			}
		},
	})

	const servers = config?.servers ?? []
	const busy = enableMutation.isPending || disableMutation.isPending

	return (
		<Card>
			<CardHeader>
				<CardTitle>Servers</CardTitle>
				<CardDescription>Enable or disable servers at runtime without restarting.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{servers.length === 0 && (
					<p className="text-sm text-muted-foreground">No servers configured.</p>
				)}
				{servers.map(server => (
					<div key={server.id} className="flex items-center justify-between">
						<div>
							<p className="font-medium text-sm">{server.displayName}</p>
							<p className="text-xs text-muted-foreground">{server.id}</p>
						</div>
						<Switch
							checked={server.enabled}
							disabled={busy}
							onCheckedChange={(checked) => {
								if (checked) enableMutation.mutate(server.id)
								else disableMutation.mutate(server.id)
							}}
						/>
					</div>
				))}
			</CardContent>
		</Card>
	)
}

function GlobalSettingsSection() {
	const settings = GlobalSettingsClient.useGlobalSettings()
	const [draft, setDraft] = React.useState<string>('')
	const [parseError, setParseError] = React.useState<string | null>(null)

	React.useEffect(() => {
		if (settings) {
			setDraft(JSON.stringify(settings, null, 2))
			setParseError(null)
		}
	}, [settings])

	const saveMutation = useMutation({
		mutationFn: async (json: string) => {
			const parsed = JSON.parse(json)
			return RPC.orpc.globalSettings.updateSettings.call(parsed)
		},
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
	})

	function handleChange(value: string) {
		setDraft(value)
		try {
			JSON.parse(value)
			setParseError(null)
		} catch {
			setParseError('Invalid JSON')
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Global Settings</CardTitle>
				<CardDescription>Edit the global settings for this SLM instance.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor="global-settings-json">Settings (JSON)</Label>
					<Textarea
						id="global-settings-json"
						className="font-mono text-xs min-h-[400px]"
						value={draft}
						onChange={e => handleChange(e.target.value)}
						spellCheck={false}
					/>
					{parseError && <p className="text-sm text-destructive">{parseError}</p>}
				</div>
				<div className="flex justify-end gap-2">
					<Button
						variant="outline"
						onClick={() => {
							if (settings) {
								setDraft(JSON.stringify(settings, null, 2))
								setParseError(null)
							}
						}}
					>
						Reset
					</Button>
					<Button
						disabled={!!parseError || saveMutation.isPending || !draft}
						onClick={() => saveMutation.mutate(draft)}
					>
						{saveMutation.isPending ? 'Saving…' : 'Save'}
					</Button>
				</div>
			</CardContent>
		</Card>
	)
}
