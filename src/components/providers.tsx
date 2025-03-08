import { QueryClientProvider } from '@tanstack/react-query'
import * as jotai from 'jotai'
import * as Jotai from 'jotai'
import { ReactNode } from 'react'
import React from 'react'

import { Toaster } from '@/components/ui/toaster'
import { reactQueryClient, trpc } from '@/trpc.client'

import { useGlobalToast } from '@/hooks/use-global-toast'
import { configAtom } from '@/systems.client/config.client'
import { DragContextProvider } from '@/systems.client/dndkit.provider'
import * as QD from '@/systems.client/queue-dashboard'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { ThemeProvider } from './theme-provider'
import { AlertDialogProvider } from './ui/lazy-alert-dialog'
import { TooltipProvider } from './ui/tooltip'

export function Providers(props: { children: ReactNode }) {
	useGlobalToast()

	return (
		<QueryClientProvider client={reactQueryClient}>
			<ReactQueryDevtools initialIsOpen={true} />
			<jotai.Provider>
				<ConfigAtomProvider>
					<ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
						<TooltipProvider>
							<DragContextProvider>
								<AlertDialogProvider>{props.children}</AlertDialogProvider>
							</DragContextProvider>
						</TooltipProvider>
						<Toaster />
					</ThemeProvider>
				</ConfigAtomProvider>
			</jotai.Provider>
		</QueryClientProvider>
	)
}

export function ConfigAtomProvider(props: { children: React.ReactNode }) {
	React.useEffect(() => {
		trpc.config.query().then((value) => {
			const store = Jotai.getDefaultStore()
			store.set(configAtom, value)
		})
	}, [])
	return <>{props.children}</>
}

// for hooks/providers that need to be used in the context of react router
export function InnerRouterProviders(props: { children: ReactNode }) {
	QD.useResetEditOnNavigate()
	return <>{props.children}</>
}
