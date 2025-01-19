import { trpc } from '@/lib/trpc.client'
import { type Config } from '@/server/config'
import * as Jotai from 'jotai'
export const configAtom = Jotai.atom(null as null | Config)

export function useConfig() {
	return Jotai.useAtomValue(configAtom, { store: Jotai.getDefaultStore() })
}
