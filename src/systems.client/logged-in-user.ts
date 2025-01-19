import { bind } from '@react-rxjs/core'
import { Observable } from 'rxjs'
import { trpc } from '@/lib/trpc.client'
import * as M from '@/models'
import * as PartSys from '@/systems.client/parts'
import type * as C from '@/server/context'

const loggedInUserCold$ = new Observable<M.User & C.WSSession>((s) => {
	trpc.getLoggedInUser.query().then((user) => {
		PartSys.upsertParts({ users: [user] })
		s.next(user)
	})
})

export const [useLoggedInUser, loggedInUser$] = bind<(M.User & C.WSSession) | null>(loggedInUserCold$, null)
