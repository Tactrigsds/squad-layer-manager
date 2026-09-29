// registers the tutorial scenarios with the tour engine
import '@/systems/tutorials/layer-queue.steps'
import '@/systems/tutorials/player-management.steps'

import { DirectionProvider } from '@radix-ui/react-direction'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'

import { DomOverlays } from '@/components/feed/dom-overlays'
import { ResetOtherSessionsManager } from '@/components/reset-other-sessions-manager'
import { TourOverlay } from '@/components/tour-overlay'
import { Toaster } from '@/components/ui/sonner'
import * as RPC from '@/orpc.client'
import { DragContextProvider } from '@/systems/dndkit.client.tsx'
import * as MessagesClient from '@/systems/messages.client'

import { DraggableWindowOutlet } from './ui/draggable-window'
import { AlertDialogProvider } from './ui/lazy-alert-dialog'

export function Providers(props: { children: ReactNode }) {
	return (
		<DirectionProvider dir={MessagesClient.textDirection()}>
			<QueryClientProvider client={RPC.queryClient}>
				<ProvidersInner>{props.children}</ProvidersInner>
			</QueryClientProvider>
		</DirectionProvider>
	)
}

function ProvidersInner(props: { children: ReactNode }) {
	return (
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
	)
}
