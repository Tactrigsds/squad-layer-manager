import { Toaster } from '@/components/ui/toaster'
import { useGlobalToast } from '@/hooks/use-global-toast'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems.client/config.client'
import { DragContextProvider } from '@/systems.client/dndkit.provider'
import * as FeatureFlagClient from '@/systems.client/feature-flags'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { ReactNode } from 'react'
import React from 'react'
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
			{(flags.reactQueryDevtools || !slmConfig?.isProduction) && <ReactQueryDevtools initialIsOpen={true} />}
			<TooltipProvider>
				<DragContextProvider>
					<AlertDialogProvider>{props.children}</AlertDialogProvider>
				</DragContextProvider>
			</TooltipProvider>
			<Toaster />
		</>
	)
}
