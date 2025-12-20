import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { assertNever } from '@/lib/type-guards'
import { cn } from '@/lib/utils'
import * as RBAC from '@/rbac.models'
import * as RbacClient from '@/systems/rbac.client'
import { useLoggedInUser, useLoggedInUserBase } from '@/systems/users.client'
import React from 'react'
import * as Zus from 'zustand'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'
import { Switch } from './ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'

export default function UserPermissionsDialog(
	props: { children: React.ReactNode; open?: boolean; onOpenChange?: (newState: boolean) => void },
) {
	const userBase = useLoggedInUserBase()
	const user = useLoggedInUser()
	const { simulateRoles, disabledRoles, enableRole, disableRole, setSimulateRoles } = Zus.useStore(RbacClient.RbacStore)

	// Group permissions by role
	const permissionsByRole = React.useMemo(() => user?.perms ? RBAC.getPermissionsByRole(user.perms) : undefined, [user?.perms])
	const setSimulateRoleId = React.useId()

	if (!userBase || !user || !permissionsByRole) {
		return (
			<Dialog open={props.open} onOpenChange={props.onOpenChange}>
				<DialogTrigger asChild>
					{props.children}
				</DialogTrigger>
				<DialogContent className="max-w-4xl">
					<DialogHeader>
						<DialogTitle>User Permissions</DialogTitle>
						<DialogDescription>View your current permissions and roles</DialogDescription>
					</DialogHeader>
					<div className="flex items-center justify-center p-8">
						<p className="text-muted-foreground">Loading user data...</p>
					</div>
				</DialogContent>
			</Dialog>
		)
	}

	const roles = new Set(userBase.perms?.flatMap(p => p.allowedByRoles))

	const formatPermissionScope = (perm: RBAC.TracedPermission) => {
		if (perm.scope === 'global') return 'Global'
		if (perm.scope === 'filter' && perm.args?.filterId) {
			return `Filter: ${perm.args.filterId}`
		}
		return perm.scope
	}

	const formatRoleName = (role: RBAC.Role) => {
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

	const getPermissionDescription = (permType: string) => {
		return RBAC.PERMISSION_DEFINITION[permType as keyof typeof RBAC.PERMISSION_DEFINITION]?.description || permType
	}

	return (
		<Dialog modal open={props.open} onOpenChange={props.onOpenChange}>
			{props.children}
			<DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle>User Permissions</DialogTitle>
					<DialogDescription>View your current permissions and roles</DialogDescription>
				</DialogHeader>

				<Tabs defaultValue="roles" className="flex-1 overflow-hidden flex flex-col">
					<TabsList className="grid w-full grid-cols-2">
						<TabsTrigger value="roles">By Role</TabsTrigger>
						<TabsTrigger value="permissions">All Permissions</TabsTrigger>
					</TabsList>

					<TabsContent value="permissions" className="flex-1 overflow-auto">
						<div className="space-y-4">
							<div className="text-sm text-muted-foreground">
								You have {userBase.perms.length} permission{userBase.perms.length !== 1 ? 's' : ''}
							</div>

							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Permission</TableHead>
										<TableHead>Description</TableHead>
										<TableHead>Scope</TableHead>
										<TableHead>Granted By</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{user.perms.map((perm) => {
										if (perm.type === 'site:authorized') return null
										const permKey = `${perm.type}:${perm.scope}:${perm.negated ? 'neg' : ''}`
										return (
											<TableRow key={permKey}>
												<TableCell className="font-mono text-sm">
													<div className="flex items-center gap-2">
														{perm.negated && (
															<Badge variant="destructive" className="text-xs">
																Negated
															</Badge>
														)}
														{perm.negating && (
															<Badge variant="outline" className="text-xs border-orange-500 text-orange-700">
																Negating
															</Badge>
														)}
														{perm.type}
													</div>
												</TableCell>
												<TableCell>
													{getPermissionDescription(perm.type)}
												</TableCell>
												<TableCell>{formatPermissionScope(perm)}</TableCell>
												<TableCell>
													<div className="flex flex-wrap gap-1">
														{perm.allowedByRoles.map((role) => (
															<Badge key={JSON.stringify(role)} variant="secondary" className="text-xs">
																{formatRoleName(role)}
															</Badge>
														))}
													</div>
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
							</Table>
						</div>
					</TabsContent>

					<TabsContent value="roles" className="flex-1 overflow-auto">
						<div className="space-y-4">
							<div className="flex items-center space-x-2 p-4 border rounded-lg bg-muted/50">
								<Switch
									checked={simulateRoles}
									onCheckedChange={setSimulateRoles}
									id={setSimulateRoleId}
								/>
								<label htmlFor={setSimulateRoleId} className="text-sm font-medium">
									Simulate roles
								</label>
								<span className="text-xs text-muted-foreground">
									Toggle roles to see how your permissions would change
								</span>
							</div>

							<div className="space-y-6">
								{[...roles]?.map((role) => {
									const perms = permissionsByRole.find(([r]) => r === role)?.[1] ?? []
									const isRoleEnabled = !simulateRoles || !disabledRoles.some(r => JSON.stringify(r) === JSON.stringify(role))

									const checkboxId = 'simulate-role-checkbox-' + JSON.stringify(role)
									return (
										<div
											key={JSON.stringify(role)}
											className={cn(
												'border rounded-lg p-4 space-y-3',
												!isRoleEnabled && simulateRoles && 'opacity-50 bg-muted/30',
											)}
										>
											<div className="flex items-center justify-between">
												<div className="flex items-center space-x-3">
													{simulateRoles && (
														<Checkbox
															id={checkboxId}
															checked={isRoleEnabled}
															onCheckedChange={(checked) => checked ? enableRole(role) : disableRole(role)}
														/>
													)}
													<div>
														<Label htmlFor={checkboxId} className="font-semibold">{formatRoleName(role)}</Label>
														<p className="text-sm text-muted-foreground">
															{perms.length} permission{perms.length !== 1 ? 's' : ''}
														</p>
													</div>
												</div>
												{simulateRoles && !isRoleEnabled && (
													<Badge variant="secondary">
														Disabled
													</Badge>
												)}
											</div>

											{isRoleEnabled && (
												<div className="space-y-2">
													{perms.map((perm) => {
														if (perm.type === 'site:authorized') return
														const permKey = `${perm.type}:${perm.scope}:${perm.negated ? 'neg' : ''}`
														return (
															<div key={permKey} className="flex items-start justify-between p-2 bg-muted/50 rounded text-sm">
																<div className="space-y-1">
																	<div className="flex items-center gap-2">
																		{perm.negated && (
																			<Badge variant="destructive" className="text-xs">
																				negated
																			</Badge>
																		)}
																		{perm.negating && (
																			<Badge variant="outline" className="text-xs border-orange-500 text-orange-700">
																				negating
																			</Badge>
																		)}
																		<div className="font-mono">
																			{perm.type}
																		</div>
																	</div>
																	<div className="text-muted-foreground">
																		{getPermissionDescription(perm.type)}
																	</div>
																</div>
																<Badge variant="outline" className="text-xs">
																	{formatPermissionScope(perm)}
																</Badge>
															</div>
														)
													})}
												</div>
											)}
										</div>
									)
								})}
							</div>
						</div>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	)
}
