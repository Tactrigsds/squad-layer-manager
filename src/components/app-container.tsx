import * as AR from '@/app-routes.ts'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import * as DH from '@/lib/display-helpers.ts'
import * as Typography from '@/lib/typography'
import { cn } from '@/lib/utils'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { useLoggedInUser } from '@/systems.client/users.client'
import { trpcConnectedAtom } from '@/trpc.client'
import { useAtomValue } from 'jotai'
import React from 'react'
import { Link } from 'react-router-dom'
import { ServerUnreachable } from './server-offline-display'
import { Alert, AlertTitle } from './ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu'

export default function AppContainer(props: { children: React.ReactNode }) {
	const trpcConnected = useAtomValue(trpcConnectedAtom)
	const statusRes = SquadServerClient.useSquadServerStatus()
	const user = useLoggedInUser()
	const avatarUrl = user?.avatar
		? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png`
		: 'https://cdn.discordapp.com/embed/avatars/0.png'

	const [openState, setDropdownState] = React.useState<'primary' | 'permissions' | null>(null)
	const onPrimaryDropdownOpenChange = (newState: boolean) => {
		if (openState !== 'primary' && openState !== null) return
		setDropdownState(newState ? 'primary' : null)
	}
	const onPermissionsOpenChange = (newState: boolean) => {
		setDropdownState(newState ? 'permissions' : null)
	}
	const primaryDropdownOpen = openState !== null
	const permissionsOpen = openState === 'permissions'
	return (
		<div className="h-full w-full">
			<nav className="flex h-16 items-center justify-between border-b px-4">
				<div className="flex items-start space-x-6">
					<Link to={AR.link('/')} className={`flex items-center space-x-2 ${location.pathname === '/' ? 'underline' : ''}`}>
						<span className={Typography.Lead}>Queue</span>
					</Link>
					<Link to={AR.link('/filters')} className={`${Typography.Lead} ${location.pathname === '/filters' ? 'underline' : ''}`}>
						Filters
					</Link>
				</div>
				<div className="flex h-max min-h-0 flex-row items-center space-x-6">
					{statusRes?.code === 'ok' && (
						<>
							{trpcConnected === false && (
								<Alert variant="destructive" className="flex items-center space-x-2">
									<AlertTitle>Websocket is Disconnected</AlertTitle>
								</Alert>
							)}
							<h3 className={Typography.H4}>{statusRes.data.name}</h3>
						</>
					)}
					{statusRes?.code === 'err:rcon' && <ServerUnreachable statusRes={statusRes} />}
					{user && (
						<DropdownMenu open={primaryDropdownOpen} onOpenChange={onPrimaryDropdownOpenChange}>
							<DropdownMenuTrigger asChild>
								<Avatar className="hover:cursor-pointer select-none">
									<AvatarImage src={avatarUrl} />
									<AvatarFallback>{user.username}</AvatarFallback>
								</Avatar>
							</DropdownMenuTrigger>
							<DropdownMenuContent>
								<DropdownMenuLabel>{user.username}</DropdownMenuLabel>
								<form action={AR.exists('/logout')} method="POST">
									<DropdownMenuItem asChild>
										<button className="w-full" type="submit">
											Log Out
										</button>
									</DropdownMenuItem>
								</form>
								<UserPermissionsDialog onOpenChange={onPermissionsOpenChange} open={permissionsOpen}>
									<DropdownMenuItem onClick={() => setDropdownState('permissions')}>Permissions</DropdownMenuItem>
								</UserPermissionsDialog>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</nav>
			<div className="flex flex-grow p-4">{props.children}</div>
		</div>
	)
}

function UserPermissionsDialog(props: { children: React.ReactNode; open: boolean; onOpenChange: (newState: boolean) => void }) {
	const user = useLoggedInUser()
	return (
		<Dialog onOpenChange={props.onOpenChange} open={props.open}>
			{props.children}
			<DialogContent className="w-max">
				<DialogHeader>
					<DialogTitle>{user?.username}</DialogTitle>
					<DialogDescription>Level of access</DialogDescription>
				</DialogHeader>
				<div className="flex space-x-4">
					<div>
						<h3 className={Typography.Large}>Permissions</h3>
						<ul>
							{user?.perms.map((perm) => {
								let scopeDisplay = perm.scope as string
								if (perm.scope === 'filter') {
									scopeDisplay = `${perm.scope} ${perm.args!.filterId}`
								}
								return (
									<li key={JSON.stringify(perm)}>
										-{' '}
										<code>
											{perm.type} ({scopeDisplay})
										</code>
									</li>
								)
							})}
						</ul>
					</div>
					<div>
						<h3 className={Typography.Large}>Roles</h3>
						<ul>
							{user?.roles.map((role) => (
								<li key={role}>
									- <code>{role}</code>
								</li>
							))}
						</ul>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
