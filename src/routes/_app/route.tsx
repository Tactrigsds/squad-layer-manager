import * as AR from '@/app-routes.ts'
import AboutDialog from '@/components/about-dialog'
import CommandsHelpDialog from '@/components/commands-help-dialog'
import NavBar from '@/components/nav-bar'
import NicknameDialog from '@/components/nickname-dialog'
import SelectLayersDialog from '@/components/select-layers-dialog'
import { ServerActionsDropdown } from '@/components/server-actions-dropdown'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import UserPermissionsDialog from '@/components/user-permissions-dialog'
import { frameManager } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { orUndef } from '@/lib/types'
import { cn } from '@/lib/utils'
import * as USR from '@/models/users.models.ts'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems/config.client'
import * as FeatureFlags from '@/systems/feature-flags.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as ThemeClient from '@/systems/theme.client'
import { useLoggedInUser } from '@/systems/users.client'
import { createFileRoute, Link, Outlet, useMatch } from '@tanstack/react-router'
import * as Icons from 'lucide-react'
import React from 'react'
import * as Zus from 'zustand'

const EXPLORE_LAYERS_FRAME_INSTANCE_ID = 'explore-layers'

export const Route = createFileRoute('/_app')({
	loader: async () => {
		void LayerQueriesClient.ensureFullSetup()
		await Promise.all([ConfigClient.fetchConfig(), SettingsClient.fetchSettings()])
		const selectedServerId = SquadServerClient.SelectedServerStore.getState().selectedServerId
		let serverFrameKey: SquadServerFrame.Key | undefined
		if (selectedServerId) {
			serverFrameKey = frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(selectedServerId))
		}
		const input = SelectLayersFrame.createInput({ sharedInstanceId: EXPLORE_LAYERS_FRAME_INSTANCE_ID, squadServer: serverFrameKey })
		const frameId = frameManager.ensureSetup(SelectLayersFrame.frame, input)
		return { stores: { exploreLayers: frameId } }
	},
	component: RouteComponent,
})

function RouteComponent() {
	// Check if we're on the server dashboard route
	const isOnServerDashboard = useMatch({ from: '/_app/servers/$serverId', shouldThrow: false })
	return (
		<div
			className="data-on-dashboard:h-screen w-full flex flex-col data-on-dashboard:overflow-hidden"
			data-on-dashboard={orUndef(!!isOnServerDashboard)}
		>
			<NavBar />
			<div className="flex flex-1 min-h-0 p-4 overflow-hidden">
				<Outlet />
			</div>
		</div>
	)
}
