// Our rxjs additions, and only those. rxjs itself is a plugin's own import (`import * as Rx from
// 'rxjs'`): it carries its own semver, and re-exporting it would put 229 lines of somebody else's
// API in ours. The Observable a plugin hands to Rpc.stream is rxjs's, so the two interoperate.
export * from '@/lib/rxjs-ext'
