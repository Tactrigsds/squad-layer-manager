import { bind } from '@react-rxjs/core'
import { Observable, Subject } from 'rxjs'
import { trpc } from '@/lib/trpc.client'
import * as M from '@/models'
import * as PartSys from '@/systems.client/parts'
import { useQuery } from '@tanstack/react-query'
import type * as C from '@/server/context'

const loggedInUserSubject$ = new Subject<(M.UserWithRbac & C.WSSession) | null>()
export async function fetchLoggedInUser() {
	loggedInUserSubject$.next(null)
	const user = await trpc.getLoggedInUser.query()
	PartSys.upsertParts({ users: [user] })
	loggedInUserSubject$.next(user)
}
fetchLoggedInUser()

export const [useLoggedInUser, loggedInUser$] = bind<(M.UserWithRbac & C.WSSession) | null>(loggedInUserSubject$, null)
