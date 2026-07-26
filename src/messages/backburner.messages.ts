import type * as Msgs from '@/messages/shared'

export const WARNS = {
	added: (parts: string[], ownCount: number, evictedCount: number) => {
		const base = `Layer request queued: ${parts.join(', ')}. You have ${ownCount} request${ownCount !== 1 ? 's' : ''} queued`
		return evictedCount > 0
			? `${base} (your oldest ${evictedCount === 1 ? 'request was' : `${evictedCount} requests were`} dropped to make room).`
			: `${base}.`
	},
	noSolutions: (request: string) => `No layers in the current pool match "${request}".`,
	backburnerFull: (max: number) => `The layer request list is full (max ${max}).`,
	removed: (description: string) => `Removed layer request: ${description}`,
	empty: 'No layer requests queued.',
} satisfies Msgs.WarnNode
