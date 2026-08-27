// registers the layer-queue scenario with the tour engine
import '@/systems/tutorials/layer-queue.steps'

import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'

import { DomOverlays } from '@/components/feed/dom-overlays'
import { ResetOtherSessionsManager } from '@/components/reset-other-sessions-manager'
import { TourOverlay } from '@/components/tour-overlay'
import { Toaster } from '@/components/ui/sonner'
import * as RPC from '@/orpc.client'
import { DragContextProvider } from '@/systems/dndkit.client.tsx'

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
	return (
		<TooltipProvider>
			<DragContextProvider>
				<AlertDialogProvider>
					<Toaster />
					<ResetOtherSessionsManager />
					<TourOverlay />
					<DraggableWindowOutlet outletKey="default">
						<DomOverlays />
						{props.children}
					</DraggableWindowOutlet>
				</AlertDialogProvider>
			</DragContextProvider>
		</TooltipProvider>
	)
}
