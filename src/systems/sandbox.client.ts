import { useQuery } from '@tanstack/react-query'

import * as RPC from '@/orpc.client'

// Which servers the session may drive as sandboxes. Empty for every install that has none, which is what gates
// the window being offered at all. Everything else the window needs lives in the sandbox frame.
export function useSandboxServers() {
	return useQuery(RPC.orpc.sandbox.listSandboxServers.queryOptions())
}
