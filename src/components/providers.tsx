import { DirectionProvider } from '@radix-ui/react-direction'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import React from 'react'

import { DomOverlays } from '@/components/feed/dom-overlays'
import { ResetOtherSessionsManager } from '@/components/reset-other-sessions-manager'
import { Toaster } from '@/components/ui/sonner'
import * as Zus from '@/lib/zustand'
import * as RPC from '@/orpc.client'
import { DragContextProvider, DragInstructions } from '@/systems/dndkit.client.tsx'
import * as MessagesClient from '@/systems/messages.client'
import * as Tour from '@/systems/tour.client'

import { DraggableWindowOutlet } from './ui/draggable-window'
import { AlertDialogProvider } from './ui/lazy-alert-dialog'

// fetched on the first tour, which most sessions never start
const TourOverlay = React.lazy(() => import('@/components/tour-overlay').then((m) => ({ default: m.TourOverlay })))

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
				<DragInstructions />
				<ResetOtherSessionsManager />
				<LazyTourOverlay />
				<DraggableWindowOutlet outletKey="default">
					<DomOverlays />
					{props.children}
				</DraggableWindowOutlet>
			</AlertDialogProvider>
		</DragContextProvider>
	)
}

function LazyTourOverlay() {
	const shown = Zus.useStore(Tour.Store, Tour.Sel.overlayShown)
	if (!shown) return null
	return (
		<React.Suspense fallback={null}>
			<TourOverlay />
		</React.Suspense>
	)
}
