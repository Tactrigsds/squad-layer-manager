import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as jotai from 'jotai'
import { ReactNode } from 'react'
import { useState } from 'react'

import { Toaster } from '@/components/ui/toaster'
import { links, trpcReact } from '@/lib/trpc.client.ts'

import { ThemeProvider } from './theme-provider'
import { AlertDialogProvider } from './ui/lazy-alert-dialog'
import { TooltipProvider } from './ui/tooltip'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { useGlobalToast } from '@/hooks/use-global-toast'

export default function Providers(props: { children: ReactNode }) {
	const [queryClient] = useState(() => new QueryClient())
	const [trpcClient] = useState(() => trpcReact.createClient({ links }))
	useGlobalToast()
	return (
		<trpcReact.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<ReactQueryDevtools initialIsOpen={true} />
				<jotai.Provider>
					<ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
						<TooltipProvider>
							<AlertDialogProvider>{props.children}</AlertDialogProvider>
						</TooltipProvider>
						<Toaster />
					</ThemeProvider>
				</jotai.Provider>
			</QueryClientProvider>
		</trpcReact.Provider>
	)
}
