import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as jotai from 'jotai'
import { ReactNode } from 'react'
import { useState } from 'react'
import * as Jotai from 'jotai'
import React from 'react'

import { Toaster } from '@/components/ui/toaster'
import { trpc } from '@/lib/trpc.client.ts'

import { ThemeProvider } from './theme-provider'
import { AlertDialogProvider } from './ui/lazy-alert-dialog'
import { TooltipProvider } from './ui/tooltip'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { useGlobalToast } from '@/hooks/use-global-toast'
import { configAtom } from '@/systems.client/config.client'
import { DragContextProvider } from '@/systems.client/dndkit.provider'

export default function Providers(props: { children: ReactNode }) {
	const [queryClient] = useState(() => new QueryClient())
	useGlobalToast()
	return (
		<QueryClientProvider client={queryClient}>
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
