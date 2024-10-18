import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as jotai from 'jotai'
import { ReactNode } from 'react'
import { useState } from 'react'

import { Toaster } from '@/components/ui/toaster'
import { links, trpcReact } from '@/lib/trpc.client.ts'

import { ThemeProvider } from './theme-provider'
import { TooltipProvider } from './ui/tooltip'

export default function Providers(props: { children: ReactNode }) {
	const [queryClient] = useState(() => new QueryClient())
	const [trpcClient] = useState(() => trpcReact.createClient({ links }))
	return (
		<trpcReact.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<jotai.Provider>
					<ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
						<TooltipProvider>{props.children}</TooltipProvider>
						<Toaster />
					</ThemeProvider>
				</jotai.Provider>
			</QueryClientProvider>
		</trpcReact.Provider>
	)
}
