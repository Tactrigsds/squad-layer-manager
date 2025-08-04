import { Toaster } from '@/components/ui/toaster'
import { useGlobalToast } from '@/hooks/use-global-toast'
import * as ConfigClient from '@/systems.client/config.client'
import { DragContextProvider } from '@/systems.client/dndkit.provider'
import * as FeatureFlagClient from '@/systems.client/feature-flags'
import * as QD from '@/systems.client/queue-dashboard'
import { reactQueryClient } from '@/trpc.client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { ReactNode } from 'react'
import React from 'react'
import { AlertDialogProvider } from './ui/lazy-alert-dialog'
import { TooltipProvider } from './ui/tooltip'

export function Providers(props: { children: ReactNode }) {
	return (
		<QueryClientProvider client={reactQueryClient}>
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

// for hooks/providers that need to be used in the context of react router
export function InnerRouterProviders(props: { children: ReactNode }) {
	QD.useResetEditOnNavigate()
	return <>{props.children}</>
}
