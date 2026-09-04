import React from 'react'

import { SubtreeFindBar } from '@/components/subtree-find-bar'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useSubtreeFind } from '@/components/use-subtree-find'
import * as Obj from '@/lib/object-utils'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as Zus from '@/lib/zustand'
import * as RBAC_Msgs from '@/messages/rbac.messages'
import * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'

import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'
import { Switch } from './ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

function formatPermissionScope(perm: RBAC.Permission) {
	if (perm.scope === 'global') return 'Global'
	if (perm.scope === 'filter' && perm.args && 'filterId' in perm.args) {
		return `Filter: ${perm.args.filterId}`
	}
	return perm.scope
}

function formatRoleName(role: RBAC.Role) {
	if (!RBAC.isInferredRoleType(role)) return role.type

	if (role.type === 'filter-role-contributor') {
		return `${role.type}: (${role.filterId}, ${role.roleId})`
	}
	if (role.type === 'filter-user-contributor') {
		return `${role.type}: (${role.filterId})`
	}
	if (role.type === 'filter-owner') {
		return `${role.type}: (${role.filterId})`
	}

	assertNever(role)
}

function getPermissionDescription(permType: string) {
	return RBAC.PERMISSION_DEFINITION[permType as keyof typeof RBAC.PERMISSION_DEFINITION]?.description || permType
}

function permKey(perm: RBAC.Permission & Partial<RBAC.PermissionTrace>) {
	return `${perm.type}:${perm.scope}:${JSON.stringify(perm.args ?? null)}:${perm.negating ? 'negating' : ''}`
}

function NegationBadges(props: { perm: RBAC.TracedPermission }) {
	return (
		<>
			{props.perm.negated && (
				<Badge variant="destructive" className="text-xs">
					{tr.text(RBAC_Msgs.negatedBadge())}
				</Badge>
			)}
			{props.perm.negating && (
				<Badge variant="outline" className="text-xs border-orange-500 text-warn">
					{tr.text(RBAC_Msgs.negatingBadge())}
				</Badge>
			)}
		</>
	)
}

// the role a permission is attributed to. Deselectable while simulating, which drops every permission this role is the
// last enabled grantor of
function RoleBadge(props: { role: RBAC.Role; simulate: boolean; enabled: boolean; onToggle: (enabled: boolean) => void }) {
	if (!props.simulate) {
		return (
			<Badge variant="secondary" className="text-xs">
				{formatRoleName(props.role)}
			</Badge>
		)
	}
	return (
		<button type="button" onClick={() => props.onToggle(!props.enabled)}>
			<Badge
				variant={props.enabled ? 'secondary' : 'outline'}
				className={cn('text-xs cursor-pointer hover:opacity-80', !props.enabled && 'line-through text-muted-foreground')}
			>
				{formatRoleName(props.role)}
			</Badge>
		</button>
	)
}

const PERMS_SHOWN_COLLAPSED = 5

function RoleSection(props: {
	role: RBAC.Role
	perms: RBAC.TracedPermission[]
	enabled: boolean
	simulate: boolean
	checkboxId: string
	onToggle: (enabled: boolean) => void
	isPermActive: (perm: RBAC.Permission) => boolean
}) {
	const [showAll, setShowAll] = React.useState(false)
	const shownPerms = showAll ? props.perms : props.perms.slice(0, PERMS_SHOWN_COLLAPSED)
	const hiddenCount = props.perms.length - shownPerms.length

	return (
		<div className={cn('border rounded-lg p-4 space-y-3', !props.enabled && 'opacity-50 bg-muted/30')}>
			<div className="flex items-center justify-between">
				<div className="flex items-center space-x-3">
					{props.simulate && (
						<Checkbox id={props.checkboxId} checked={props.enabled} onCheckedChange={(checked) => props.onToggle(checked === true)} />
					)}
					<div>
						<Label htmlFor={props.checkboxId} className="font-semibold">
							{formatRoleName(props.role)}
						</Label>
						<p className="text-sm text-muted-foreground">{tr.text(RBAC_Msgs.rolePermissionCount(props.perms.length))}</p>
					</div>
				</div>
				{props.simulate && !props.enabled && <Badge variant="secondary">{tr.text(RBAC_Msgs.roleDisabledBadge())}</Badge>}
			</div>

			{props.enabled && (
				<div className="space-y-2">
					{shownPerms.map((perm) => (
						<div
							key={permKey(perm)}
							className={cn(
								'flex items-start justify-between p-2 bg-muted/50 rounded text-sm',
								props.simulate && !perm.negating && !props.isPermActive(perm) && 'opacity-50',
							)}
						>
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<NegationBadges perm={perm} />
									<div className="font-mono">{perm.type}</div>
								</div>
								<div className="text-muted-foreground">{getPermissionDescription(perm.type)}</div>
							</div>
							<Badge variant="outline" className="text-xs">
								{formatPermissionScope(perm)}
							</Badge>
						</div>
					))}
					{(hiddenCount > 0 || showAll) && (
						<Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setShowAll(!showAll)}>
							{showAll ? 'Show fewer' : `...see all ${props.perms.length}`}
						</Button>
					)}
				</div>
			)}
		</div>
	)
}

export default function UserPermissionsDialog(props: {
	children: React.ReactNode
	open?: boolean
	onOpenChange?: (newState: boolean) => void
}) {
	const user = UsersClient.useLoggedInUser()
	const {
		simulate,
		setSimulate,
		disabledRoles,
		enableRole,
		disableRole,
		addedRoles,
		addRole,
		removeRole,
		disabledPerms,
		disablePerm,
		enablePerm,
	} = Zus.useStore(RbacClient.RbacStore)
	const simulatableRoles = RbacClient.useSimulatableRoles().data

	const shownPerms = Zus.useStore(UsersClient.loggedInUserQueryOptions, RbacClient.RbacStore, RbacClient.Sel.shownPerms)
	const heldRoles = Zus.useStore(UsersClient.loggedInUserQueryOptions, RbacClient.myRolesQueryOptions, RbacClient.Sel.heldRoles)
	const unheldRoles = Zus.useStore(RbacClient.userDefinedRolesQueryOptions, RbacClient.myRolesQueryOptions, RbacClient.Sel.unheldRoles)
	const unheldPermTypes = Zus.useStore(UsersClient.loggedInUserQueryOptions, RbacClient.Sel.unheldPermTypes)

	const simulateId = React.useId()
	// a session per tab: the inactive tab's content is unmounted, so one shared session would have nothing to search
	const permsFind = useSubtreeFind()
	const rolesFind = useSubtreeFind()

	if (!user) {
		return (
			<Dialog open={props.open} onOpenChange={props.onOpenChange}>
				<DialogTrigger asChild>{props.children}</DialogTrigger>
				<DialogContent className="max-w-4xl">
					<DialogHeader>
						<DialogTitle>{tr.text(RBAC_Msgs.userPermissionsTitle())}</DialogTitle>
						<DialogDescription>{tr.text(RBAC_Msgs.userPermissionsBlurb())}</DialogDescription>
					</DialogHeader>
					<div className="flex items-center justify-center p-8">
						<p className="text-muted-foreground">{tr.text(RBAC_Msgs.loadingUser())}</p>
					</div>
				</DialogContent>
			</Dialog>
		)
	}

	const isRoleEnabled = (role: RBAC.Role) => !simulate || !disabledRoles.some((r) => Obj.deepEqual(r, role))
	const isPermDisabled = (perm: RBAC.Permission) => disabledPerms.some((p) => RBAC.isSamePerm(p, perm))
	const getSimulatableRole = (role: RBAC.Role) => simulatableRoles?.find((r) => Obj.deepEqual(r.role, role))
	// granted under whatever simulation is currently in effect
	const isPermActive = (perm: RBAC.Permission) => user.perms.some((p) => RBAC.isSamePerm(p, perm) && !p.negated)

	const toggleRole = (role: RBAC.Role, enabled: boolean) => {
		if (enabled) enableRole(role)
		else disableRole(role)
	}

	const activePermCount = user.perms.filter((p) => !p.negated && !p.negating).length

	return (
		<Dialog modal open={props.open} onOpenChange={props.onOpenChange}>
			{props.children}
			<DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle>{tr.text(RBAC_Msgs.userPermissionsTitle())}</DialogTitle>
					<DialogDescription>{tr.text(RBAC_Msgs.userPermissionsBlurb())}</DialogDescription>
				</DialogHeader>

				<div className="flex items-center space-x-3 p-4 border rounded-lg bg-muted/50">
					<Switch checked={simulate} onCheckedChange={setSimulate} id={simulateId} />
					<Label htmlFor={simulateId} className="text-sm font-medium shrink-0">
						{tr.text(RBAC_Msgs.simulate())}
					</Label>
					<span className="text-xs text-muted-foreground text-balance leading-relaxed">{tr.text(RBAC_Msgs.simulateBlurb())}</span>
				</div>

				<Tabs defaultValue="roles" className="flex-1 overflow-hidden flex flex-col">
					<TabsList className="grid w-full grid-cols-2">
						<TabsTrigger value="roles">{tr.text(RBAC_Msgs.byRoleTab())}</TabsTrigger>
						<TabsTrigger value="permissions">{tr.text(RBAC_Msgs.allPermissionsTab())}</TabsTrigger>
					</TabsList>

					{/* the bar is pinned rather than scrolling, and the content is padded clear of it: unlike a feed, a tab
					    here starts at its first row, so an overlay would sit on the table header */}
					<TabsContent value="permissions" className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
						<SubtreeFindBar stores={permsFind.stores} className="absolute right-4 top-0" />
						<div ref={permsFind.scopeRef} className="min-h-0 flex-1 space-y-4 overflow-auto pt-10">
							<div className="text-sm text-muted-foreground">{tr.text(RBAC_Msgs.heldPermissionCount(activePermCount))}</div>

							<Table>
								<TableHeader>
									<TableRow>
										{simulate && <TableHead className="w-8" />}
										<TableHead>{tr.text(RBAC_Msgs.permissionColumn())}</TableHead>
										<TableHead>{tr.text(RBAC_Msgs.descriptionColumn())}</TableHead>
										<TableHead>{tr.text(RBAC_Msgs.scopeColumn())}</TableHead>
										<TableHead>{tr.text(RBAC_Msgs.grantedByColumn())}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{shownPerms.map((perm) => {
										// a negating permission is what takes access away, so switching it off could only grant access
										const canToggle = simulate && !perm.negating
										const checkboxId = 'simulate-perm-checkbox-' + permKey(perm)
										return (
											<TableRow
												key={permKey(perm)}
												className={cn(simulate && !perm.negating && !isPermActive(perm) && 'opacity-50')}
											>
												{simulate && (
													<TableCell>
														{canToggle && (
															<Checkbox
																id={checkboxId}
																checked={!isPermDisabled(perm)}
																onCheckedChange={(checked) => (checked ? enablePerm(perm) : disablePerm(perm))}
															/>
														)}
													</TableCell>
												)}
												<TableCell className="font-mono text-sm">
													<div className="flex items-center gap-2">
														<NegationBadges perm={perm} />
														<Label htmlFor={checkboxId}>{perm.type}</Label>
													</div>
												</TableCell>
												<TableCell>{getPermissionDescription(perm.type)}</TableCell>
												<TableCell>{formatPermissionScope(perm)}</TableCell>
												<TableCell>
													<div className="flex flex-wrap gap-1">
														{perm.allowedByRoles.map((role) => (
															<RoleBadge
																key={JSON.stringify(role)}
																role={role}
																simulate={simulate}
																enabled={isRoleEnabled(role)}
																onToggle={(enabled) => toggleRole(role, enabled)}
															/>
														))}
													</div>
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
							</Table>

							<section className="space-y-2">
								<h3 className="text-sm font-semibold">{tr.text(RBAC_Msgs.unheldPermissionsHeading())}</h3>
								{unheldPermTypes.length === 0 ? (
									<p className="text-sm text-muted-foreground">{tr.text(RBAC_Msgs.holdsEveryPermission())}</p>
								) : (
									<div className="space-y-1">
										{unheldPermTypes.map((permType) => (
											<div
												key={permType}
												className="flex items-start justify-between p-2 rounded text-sm opacity-60 bg-muted/30"
											>
												<div className="space-y-1">
													<div className="font-mono">{permType}</div>
													<div className="text-muted-foreground">{getPermissionDescription(permType)}</div>
												</div>
												<Badge variant="outline" className="text-xs">
													{RBAC.PERMISSION_DEFINITION[permType].scope}
												</Badge>
											</div>
										))}
									</div>
								)}
							</section>
						</div>
					</TabsContent>

					<TabsContent value="roles" className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
						<SubtreeFindBar stores={rolesFind.stores} className="absolute right-4 top-0" />
						<div ref={rolesFind.scopeRef} className="min-h-0 flex-1 space-y-6 overflow-auto pt-10">
							{heldRoles.map(({ role, perms }) => (
								<RoleSection
									key={JSON.stringify(role)}
									role={role}
									perms={perms}
									enabled={isRoleEnabled(role)}
									simulate={simulate}
									checkboxId={'simulate-role-checkbox-' + JSON.stringify(role)}
									onToggle={(enabled) => toggleRole(role, enabled)}
									isPermActive={isPermActive}
								/>
							))}

							<section className="space-y-3">
								<div>
									<h3 className="text-sm font-semibold">{tr.text(RBAC_Msgs.unheldRolesHeading())}</h3>
									<p className="text-xs text-muted-foreground">{tr.text(RBAC_Msgs.unheldRolesBlurb())}</p>
								</div>
								{unheldRoles.length === 0 && <p className="text-sm text-muted-foreground">{tr.text(RBAC_Msgs.holdsEveryRole())}</p>}
								{unheldRoles.map((role) => {
									const simulatable = getSimulatableRole(role)
									const added = !!simulatable && addedRoles.some((a) => Obj.deepEqual(a.role, role))
									const checkboxId = 'add-role-checkbox-' + JSON.stringify(role)
									if (simulatable && added) {
										return (
											<RoleSection
												key={JSON.stringify(role)}
												role={role}
												perms={simulatable.perms}
												enabled={isRoleEnabled(role)}
												simulate={simulate}
												checkboxId={checkboxId}
												onToggle={() => removeRole(role)}
												isPermActive={isPermActive}
											/>
										)
									}
									return (
										<div
											key={JSON.stringify(role)}
											className="flex items-center justify-between border rounded-lg p-4 bg-muted/30"
										>
											<div className="flex items-center space-x-3">
												{simulate && simulatable && (
													<Checkbox id={checkboxId} checked={false} onCheckedChange={() => addRole(simulatable)} />
												)}
												<Label htmlFor={checkboxId} className={cn('font-semibold', !simulatable && 'text-muted-foreground')}>
													{formatRoleName(role)}
												</Label>
											</div>
											{!simulatable && (
												<Badge variant="outline" className="text-xs">
													{tr.text(RBAC_Msgs.roleGrantsMore())}
												</Badge>
											)}
										</div>
									)
								})}
							</section>
						</div>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	)
}
