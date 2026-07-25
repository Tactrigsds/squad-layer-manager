import { parseArgs } from 'node:util'

import * as Slots from '../dev/slots.ts'

// The one url for this worktree's dev instance, signed in, for pasting into a browser or a report.
// `pnpm -s dev:url [path]`.

const args = parseArgs({ allowPositionals: true })
console.log(Slots.instanceUrl(Slots.requireSlot(), args.positionals[0] ?? '/'))
