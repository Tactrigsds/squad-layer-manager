import * as Icons from 'lucide-react'
import React from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as F_Msgs from '@/messages/filter.messages'
import type * as USR from '@/models/users.models'
import type * as RBAC from '@/rbac.models'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'

// The users and roles who may edit an entity they do not own, such as a filter or a rotation
export function ContributorsPopover(props: {
	contributors: { users: USR.User[]; roles: string[] } | undefined
	description: string
	// managing contributors is an ownership concern; contributors can view the list but not edit it
	canManage: boolean
	onAddUser: (user: USR.User) => void
	onAddRole: (role: RBAC.GenericRole) => void
	onRemoveUser: (userId: USR.UserId) => void
	onRemoveRole: (roleId: string) => void
	children: React.ReactNode
}) {
	const { contributors } = props
	return (
		<Popover>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent className="p-0">
				<CardHeader>
					<CardTitle>{tr.text(F_Msgs.contributorsHeading())}</CardTitle>
					<CardDescription>{props.description}</CardDescription>
				</CardHeader>
				<CardContent>
					<div id="users">
						<div className="flex items-center space-x-2">
							<h4 className="leading-none">{tr.text(F_Msgs.usersHeading())}</h4>
							{props.canManage && (
								<SelectUserPopover selectUser={props.onAddUser}>
									<Button variant="outline" size="icon">
										<Icons.Plus />
									</Button>
								</SelectUserPopover>
							)}
						</div>
						<ul>
							{contributors?.users.map((user) => (
								<li key={user.discordId} className="flex items-center space-x-1">
									{props.canManage && (
										<Icons.Minus
											onClick={() => props.onRemoveUser(user.discordId)}
											className="text-destructive hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
										/>
									)}
									<Badge>{user.displayName}</Badge>
								</li>
							))}
						</ul>
					</div>
					<div id="roles">
						<div>
							<Label htmlFor="roles">{tr.text(F_Msgs.rolesHeading())}</Label>
							{props.canManage && (
								<SelectUserDefinedRolePopover selectRole={props.onAddRole}>
									<Button variant="outline" size="icon">
										<Icons.Plus />
									</Button>
								</SelectUserDefinedRolePopover>
							)}
						</div>
						<ul>
							{contributors?.roles.map((role) => (
								<li key={role} className="flex items-center space-x-1">
									{props.canManage && (
										<Icons.Minus
											onClick={() => props.onRemoveRole(role)}
											className="text-destructive hover:bg-accent hover:text-accent-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
										/>
									)}
									<Badge>{role}</Badge>
								</li>
							))}
						</ul>
					</div>
				</CardContent>
			</PopoverContent>
		</Popover>
	)
}

export function SelectUserPopover(props: { children: React.ReactNode; selectUser: (user: USR.User) => void }) {
	const usersRes = UsersClient.useUsers()
	const [isOpen, setIsOpen] = React.useState(false)
	function onSelect(user: USR.User) {
		props.selectUser(user)
		setIsOpen(false)
	}
	return (
		<Popover modal open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent>
				<Command>
					<CommandInput placeholder={tr.text(F_Msgs.searchUsers())} />
					<CommandList>
						{usersRes.data?.code === 'ok' &&
							usersRes.data.users.map((user) => (
								<CommandItem key={user.discordId} onSelect={() => onSelect(user)}>
									{user.displayName}
								</CommandItem>
							))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}

export function SelectUserDefinedRolePopover(props: { children: React.ReactNode; selectRole: (role: RBAC.GenericRole) => void }) {
	const rolesRes = RbacClient.useUserDefinedRoles()
	const [isOpen, setIsOpen] = React.useState(false)
	function onSelect(role: RBAC.Role) {
		props.selectRole(role)
		setIsOpen(false)
	}
	return (
		<Popover open={isOpen} onOpenChange={setIsOpen} modal>
			<PopoverTrigger asChild>{props.children}</PopoverTrigger>
			<PopoverContent>
				<Command>
					<CommandInput placeholder={tr.text(F_Msgs.searchRoles())} />
					<CommandList>
						{rolesRes.data?.map((role) => (
							<CommandItem key={role.type} onSelect={() => onSelect(role)}>
								{role.type}
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	)
}
