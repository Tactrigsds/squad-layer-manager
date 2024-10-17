import { atom, useAtom } from 'jotai'

import { trpcJotai } from './lib/trpc.client'
import * as M from './models'

export const loggedInUserAtom = trpcJotai.getLoggedInUser.atomWithQuery(() => {})
