import * as C from '@/server/context'
import * as OrpcServer from '@orpc/server'

export default OrpcServer.os.$context<C.Socket>()
