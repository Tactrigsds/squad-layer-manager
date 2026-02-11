import { Toaster } from '@/components/ui/toaster'
import { useGlobalToast } from '@/hooks/use-global-toast'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import { DragContextProvider } from '@/systems/dndkit.client.tsx'
import * as FeatureFlagClient from '@/systems/feature-flags.client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import type { ReactNode } from 'react'
import React, { Suspense } from 'react'
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
	useGlobalToast()
	const slmConfig = ConfigClient.useConfig()
	const flags = FeatureFlagClient.useFeatureFlags()

	return (
		<>
			{(flags.reactQueryDevtools || !slmConfig?.isProduction) && <ReactQueryDevtools initialIsOpen />}
			<TooltipProvider>
				<DragContextProvider>
					<AlertDialogProvider>
						<Toaster />
						<Suspense fallback={null}>
							<DraggableWindowOutlet />
						</Suspense>
						{props.children}
					</AlertDialogProvider>
				</DragContextProvider>
			</TooltipProvider>
		</>
	)
}
