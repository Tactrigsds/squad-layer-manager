import { useQuery } from '@tanstack/react-query'
import * as Icons from 'lucide-react'
import React from 'react'

import { ServerMultiSelect } from '@/components/server-select'
import { RoleAssignmentsEditor } from '@/components/settings-form/editors/rbac-assignments'
import { RolePermissionsTable } from '@/components/settings-form/editors/rbac-permissions'
import {
	isRoleAssigned,
	type RbacUpdate,
	type RbacValue,
	type RoleConfig,
	VALID_ROLE_ID,
	withRoleConfig,
	withRoleRemoved,
	withRoleRenamed,
} from '@/components/settings-form/editors/rbac.helpers'
import { scopeValue, useFieldValue, ValidationContext, type ValueState } from '@/components/settings-form/settings-form.helpers'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type * as Rx from '@/lib/rxjs'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import * as RPC from '@/orpc.client'
import { tr } from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as UsersClient from '@/systems/users.client'

// the env-configured SUPER_USERS/SUPER_ROLES bootstrap: shown read-only at the top of the rbac section so admins know
// these grants exist, and that they can only be changed via the environment, not from this page
export function RbacSuperCallout() {
	const superRes = useQuery(RPC.orpc.rbac.getSuperConfig.queryOptions({ staleTime: Infinity }))
	const superUsers = superRes.data?.code === 'ok' ? superRes.data.superUsers : []
	const superRoles = superRes.data?.code === 'ok' ? superRes.data.superRoles : []
	const rolesRes = useQuery(RPC.orpc.rbac.listGuildRoles.queryOptions({ staleTime: Infinity }))
	const guildRoles = rolesRes.data?.code === 'ok' ? rolesRes.data.roles : []
	const userIds = superUsers.map(BigInt)
	const usersRes = UsersClient.useUsers(userIds, { enabled: userIds.length > 0 })
	const userMap = new Map((usersRes.data?.code === 'ok' ? usersRes.data.users : []).map((u) => [String(u.discordId), u]))

	if (superUsers.length === 0 && superRoles.length === 0) return null

	return (
		<div className="space-y-2 rounded-md border border-info/40 bg-info/10 p-3">
			<p className="flex items-center gap-1.5 text-sm font-medium">
				<Icons.ShieldCheck className="h-4 w-4 shrink-0" />
				{tr.text(RBAC_Msgs.superUsersAndRoles())}
			</p>
			<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.superBlurb())}</p>
			{superUsers.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.superUsersLabel())}</span>
					{superUsers.map((id) => (
						<span key={id} className="rounded border bg-background px-1.5 py-0.5 text-xs" title={id}>
							{userMap.get(id)?.displayName ?? <span className="font-mono ltr-isolate">{id}</span>}
						</span>
					))}
				</div>
			)}
			{superRoles.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.superRolesLabel())}</span>
					{superRoles.map((id) => {
						const role = guildRoles.find((r) => r.id === id)
						return (
							<span key={id} className="flex items-center gap-1.5 rounded border bg-background px-1.5 py-0.5 text-xs" title={id}>
								{role ? (
									<>
										<span
											className="h-2 w-2 shrink-0 rounded-full border"
											style={{ backgroundColor: role.color ?? 'transparent' }}
										/>
										{role.name}
									</>
								) : (
									<span className="font-mono ltr-isolate">{id}</span>
								)}
							</span>
						)
					})}
				</div>
			)}
		</div>
	)
}

export function RbacBody({ value$, reset$, onChange }: { value$: ValueState; reset$: Rx.Subject<void>; onChange: (v: any) => void }) {
	const rbac = (useFieldValue(value$) as RbacValue) ?? {}
	const roleIds = Object.keys(rbac.roles ?? {})
	const issues = React.useContext(ValidationContext).filter((i) => i.path.startsWith('rbac.'))

	// falls back to the first role while the requested one does not exist, so a rename or delete cannot strand it
	const [requestedRole, setSelected] = React.useState<string | null>(null)
	const selected = requestedRole && roleIds.includes(requestedRole) ? requestedRole : (roleIds[0] ?? null)

	// `quiet` skips reset$: use it for edits driven by an uncontrolled input (the timeout duration field), where re-emitting
	// would clobber an in-flight keystroke. Structural edits (add/remove/rename/toggles) leave it off so inputs re-seed.
	const update = React.useCallback<RbacUpdate>(
		(fn, quiet) => {
			onChange(fn((value$.getValue() as RbacValue) ?? {}))
			if (!quiet) reset$.next()
		},
		[onChange, value$, reset$],
	)

	const [newRole, setNewRole] = React.useState('')
	const canAdd = VALID_ROLE_ID.test(newRole) && !(newRole in (rbac.roles ?? {}))
	function addRole() {
		if (!canAdd) return
		update((r) => ({ ...r, roles: { ...(r.roles ?? {}), [newRole]: { permissions: [] } } }))
		setSelected(newRole)
		setNewRole('')
	}
	// explicit empty roles (not undefined) so it stays cleared rather than re-triggering the schema's preset default
	function clearAll() {
		update((r) => ({ ...r, roles: {} }))
		setSelected(null)
	}

	return (
		<div className="space-y-3">
			{issues.length > 0 && (
				<div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 space-y-0.5">
					{issues.map((i, n) => (
						// oxlint-disable-next-line no-array-index-key
						<p key={n} className="flex items-start gap-1.5 text-xs text-destructive">
							<Icons.TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
							<span>
								<code className="text-[10px] ltr-isolate">{i.path}</code> {i.message}
							</span>
						</p>
					))}
				</div>
			)}
			{roleIds.length > 0 && (
				<div className="flex items-center justify-between">
					<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.roleCount(roleIds.length))}</p>
					<Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={clearAll}>
						<Icons.Trash2 className="me-1 h-4 w-4" />
						{tr.text(RBAC_Msgs.clearAllRoles())}
					</Button>
				</div>
			)}
			<div className="space-y-3">
				<div className="flex flex-wrap items-center gap-1.5">
					{roleIds.length === 0 && <p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.noRoles())}</p>}
					{roleIds.map((id) => (
						<button
							key={id}
							type="button"
							onClick={() => setSelected(id)}
							className={cn(
								'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-start font-mono text-sm',
								id === selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-accent/50',
							)}
						>
							<span className="max-w-[16rem] truncate">{id}</span>
							{!isRoleAssigned(rbac.roles?.[id]) && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Icons.TriangleAlert className="h-3 w-3 shrink-0 text-warn dark:text-warn" />
									</TooltipTrigger>
									<TooltipContent>{tr.text(RBAC_Msgs.roleUnassignedShort())}</TooltipContent>
								</Tooltip>
							)}
						</button>
					))}
					<div className="flex items-center gap-1.5">
						<Input
							className="h-8 w-[11rem] font-mono"
							placeholder={tr.text(RBAC_Msgs.newRoleId())}
							value={newRole}
							onChange={(e) => setNewRole(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault()
									addRole()
								}
							}}
						/>
						<Button type="button" size="icon" variant="outline" className="h-8 w-8 shrink-0" disabled={!canAdd} onClick={addRole}>
							<Icons.Plus className="h-4 w-4" />
						</Button>
					</div>
				</div>
				{selected ? (
					<RoleDetail
						key={selected}
						roleId={selected}
						rbac={rbac}
						value$={value$}
						reset$={reset$}
						update={update}
						assigned={isRoleAssigned(rbac.roles?.[selected])}
					/>
				) : (
					<p className="text-sm text-muted-foreground">{tr.text(RBAC_Msgs.selectARole())}</p>
				)}
			</div>
		</div>
	)
}

function RoleSubsection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
	return (
		<section className="space-y-1.5">
			<h4 className="text-sm font-semibold">{title}</h4>
			{description && <p className="text-xs text-muted-foreground">{description}</p>}
			{children}
		</section>
	)
}

function RoleDetail({
	roleId,
	rbac,
	value$,
	reset$,
	update,
	assigned,
}: {
	roleId: string
	rbac: RbacValue
	value$: ValueState
	reset$: Rx.Subject<void>
	update: RbacUpdate
	assigned: boolean
}) {
	const [renaming, setRenaming] = React.useState(false)
	const cfg = rbac.roles?.[roleId] ?? {}
	// scoped value-states for the timeout / layer-request cells so they can reuse the uncontrolled TextInputField
	const timeout$ = scopeValue(scopeValue(scopeValue(value$, 'roles'), roleId), 'maxTimeout')
	const layerRequests$ = scopeValue(scopeValue(scopeValue(value$, 'roles'), roleId), 'maxLayerRequests')

	return (
		<div className="min-w-0 space-y-4 rounded-md border p-3">
			<div className="flex items-center gap-2">
				{renaming ? (
					<Input
						autoFocus
						className="h-8 max-w-[16rem] font-mono"
						defaultValue={roleId}
						onBlur={(e) => {
							const next = e.target.value.trim()
							setRenaming(false)
							if (next && next !== roleId && VALID_ROLE_ID.test(next) && !(next in (rbac.roles ?? {}))) {
								update((r) => withRoleRenamed(r, roleId, next))
							}
						}}
						onKeyDown={(e) => {
							if (e.key === 'Enter') e.currentTarget.blur()
							if (e.key === 'Escape') setRenaming(false)
						}}
					/>
				) : (
					<>
						<h3 className="font-mono text-base font-semibold">{roleId}</h3>
						<Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => setRenaming(true)}>
							<Icons.Pencil className="h-3.5 w-3.5" />
						</Button>
					</>
				)}
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="ms-auto text-destructive"
					onClick={() => update((r) => withRoleRemoved(r, roleId))}
				>
					<Icons.Trash2 className="me-1 h-4 w-4" />
					{tr.text(RBAC_Msgs.deleteRole())}
				</Button>
			</div>

			<RoleSubsection title={tr.text(RBAC_Msgs.permissions())} description={tr.text(RBAC_Msgs.permissionsBlurb())}>
				<RolePermissionsTable
					roleId={roleId}
					permissions={cfg.permissions}
					globalSettingsGrants={cfg.globalSettingsGrants}
					serverGrants={cfg.serverGrants}
					serverSettingsGrants={cfg.serverSettingsGrants}
					maxTimeout={cfg.maxTimeout}
					maxLayerRequests={cfg.maxLayerRequests}
					timeout$={timeout$}
					layerRequests$={layerRequests$}
					reset$={reset$}
					update={update}
				/>
			</RoleSubsection>

			<RoleSubsection title={tr.text(RBAC_Msgs.pluginActions())} description={tr.text(RBAC_Msgs.pluginActionsBlurb())}>
				<RolePluginGrants roleId={roleId} grants={cfg.pluginGrants} update={update} />
			</RoleSubsection>

			<RoleSubsection title={tr.text(RBAC_Msgs.assignments())} description={tr.text(RBAC_Msgs.assignmentsBlurb())}>
				<RoleAssignmentsEditor roleId={roleId} assignments={cfg.assignments} update={update} assigned={assigned} />
			</RoleSubsection>
		</div>
	)
}

// What the running plugins define for themselves. Not rows in RolePermissionsTable: that table is keyed by
// permission type alone, and a plugin action needs the plugin's id beside it. Listed from the live declarations so
// an admin picks rather than types, with any grant nothing declares kept and shown as unresolved -- a stopped or
// not-yet-installed plugin must not silently lose the grants an admin made for it.
function RolePluginGrants(props: { roleId: string; grants: RoleConfig['pluginGrants']; update: RbacUpdate }) {
	const { roleId, update } = props
	const plugins = Zus.useStore(PluginsClient.Store, (s) => s.plugins)
	const grants = props.grants ?? []
	const declared = plugins.flatMap((info) => info.permissions.map((decl) => ({ pluginId: info.id, pluginName: info.name, decl })))
	const heldBy = (pluginId: string, name: string) => grants.find((g) => g.pluginId === pluginId && g.permission === name)
	const unresolved = grants.filter((g) => !declared.some((d) => d.pluginId === g.pluginId && d.decl.name === g.permission))

	function setGrants(next: RoleConfig['pluginGrants']) {
		update((r) => withRoleConfig(r, roleId, (c) => ({ ...c, pluginGrants: next })))
	}
	function toggle(pluginId: string, name: string, on: boolean) {
		setGrants(
			on
				? [...grants, { pluginId, permission: name, serverIds: [] }]
				: grants.filter((g) => !(g.pluginId === pluginId && g.permission === name)),
		)
	}
	function setServers(pluginId: string, name: string, serverIds: string[]) {
		setGrants(grants.map((g) => (g.pluginId === pluginId && g.permission === name ? { ...g, serverIds } : g)))
	}

	if (declared.length === 0 && unresolved.length === 0) {
		return <p className="text-sm text-muted-foreground">{tr.text(RBAC_Msgs.noPluginActions())}</p>
	}
	return (
		<div className="space-y-2">
			{declared.map(({ pluginId, pluginName, decl }) => {
				const grant = heldBy(pluginId, decl.name)
				return (
					<div key={`${pluginId}:${decl.name}`} className="flex flex-wrap items-start gap-2">
						<Checkbox className="mt-1" checked={!!grant} onCheckedChange={(v) => toggle(pluginId, decl.name, v)} />
						<div className="min-w-0 space-y-0.5">
							<div className="flex flex-wrap items-baseline gap-2">
								<span className="font-mono text-xs">{decl.name}</span>
								<span className="text-xs text-muted-foreground">{pluginName}</span>
							</div>
							<p className="text-xs text-muted-foreground">{decl.description}</p>
							{grant && decl.scope === 'server' && (
								<ServerMultiSelect
									className="max-w-md"
									values={grant.serverIds}
									onChange={(next) => setServers(pluginId, decl.name, next)}
									title={tr.text(RBAC_Msgs.pluginActionServers())}
								/>
							)}
						</div>
					</div>
				)
			})}
			{unresolved.length > 0 && (
				<div className="space-y-1 rounded-md border border-dashed p-2">
					<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.pluginActionsUnresolved())}</p>
					{unresolved.map((g) => (
						<div key={`${g.pluginId}:${g.permission}`} className="flex items-center gap-2">
							<code className="text-xs">
								{g.pluginId}:{g.permission}
							</code>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => toggle(g.pluginId, g.permission, false)}
							>
								{tr.text(RBAC_Msgs.removeGrant())}
							</Button>
						</div>
					))}
				</div>
			)}
		</div>
	)
}
