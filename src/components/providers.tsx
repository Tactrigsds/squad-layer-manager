// registers the layer-queue-basics scenario with the tour engine
import '@/systems/tutorials/layer-queue-basics.steps'

import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import type { ReactNode } from 'react'
import React from 'react'

import { ResetOtherSessionsManager } from '@/components/reset-other-sessions-manager'
import { TourOverlay } from '@/components/tour-overlay'
import { Toaster } from '@/components/ui/sonner'
import * as Zus from '@/lib/zustand'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import { DragContextProvider } from '@/systems/dndkit.client.tsx'
import * as FeatureFlagClient from '@/systems/feature-flags.client'

import { DraggableWindowOutlet } from './ui/draggable-window'
import { AlertDialogProvider } from './ui/lazy-alert-dialog'
import { TooltipProvider } from './ui/tooltip'

export function Providers(props: { children: ReactNode }) {
	return (
		<QueryClientProvider client={RPC.queryClient}>
			<ProvidersInner>{props.children}</ProvidersInner>
		</QueryClientProvider>
	)
}

function ProvidersInner(props: { children: ReactNode }) {
	const slmConfig = Zus.useStore(ConfigClient.Store)
	const flags = FeatureFlagClient.useFeatureFlags()

	return (
		<>
			{(flags.reactQueryDevtools || !slmConfig?.isProduction) && <ReactQueryDevtools initialIsOpen={false} />}
			<TooltipProvider>
				<DragContextProvider>
					<AlertDialogProvider>
						<Toaster />
						<ResetOtherSessionsManager />
						<TourOverlay />
						<DraggableWindowOutlet outletKey="default">{props.children}</DraggableWindowOutlet>
					</AlertDialogProvider>
				</DragContextProvider>
			</TooltipProvider>
		</>
	)
}
