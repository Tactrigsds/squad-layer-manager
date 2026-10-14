import * as CD from '@/lib/ctx-def'
import type * as GCtx from '@/lib/generic-ctx'

export * from '@/lib/generic-ctx'

// every per-server context composes with this, so it lives in the leaf: a domain models file taking
// it from server-state would close a runtime cycle, since server-state imports several of them for
// their schemas.
export type ServerId = GCtx.Ctx & {
	serverId: string
}
export const ServerIdDef = CD.defCtx<ServerId>()(['serverId'], { name: 'serverId' })
