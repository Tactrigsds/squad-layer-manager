import { ResetOtherSessionsManager } from '@/components/reset-other-sessions-manager'
import { Toaster } from '@/components/ui/sonner'
import * as ZusUtils from '@/lib/zustand'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import { DragContextProvider } from '@/systems/dndkit.client.tsx'
import * as FeatureFlagClient from '@/systems/feature-flags.client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import type { ReactNode } from 'react'
import React from 'react'
import { DraggableWindowOutlet } from './ui/draggable-window'
import { AlertDialogProvider } from './ui/lazy-alert-dialog'
import { TooltipProvider } from './ui/tooltip'

export function Providers(props: { children: ReactNode }) {
	return (
		<QueryClientProvider client={RPC.queryClient}>
			<ProvidersInner>
				{props.children}
			</ProvidersInner>
		</QueryClientProvider>
	)
}

function ProvidersInner(props: { children: ReactNode }) {
	const slmConfig = ZusUtils.useStore(ConfigClient.Store)
	const flags = FeatureFlagClient.useFeatureFlags()

	return (
		<>
			{(flags.reactQueryDevtools || !slmConfig?.isProduction) && <ReactQueryDevtools initialIsOpen />}
			<TooltipProvider>
				<DragContextProvider>
					<AlertDialogProvider>
						<Toaster />
						<ResetOtherSessionsManager />
						<DraggableWindowOutlet outletKey="default">
							{props.children}
						</DraggableWindowOutlet>
					</AlertDialogProvider>
				</DragContextProvider>
			</TooltipProvider>
		</>
	)
}
