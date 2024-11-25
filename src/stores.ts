import { trpcJotai } from './lib/trpc.client'
export const loggedInUserAtom = trpcJotai.getLoggedInUser.atomWithQuery(() => {})
