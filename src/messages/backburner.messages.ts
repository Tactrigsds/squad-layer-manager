import * as Msgs from '@/messages/shared'

export const added = Msgs.def((parts: string[], ownCount: number, evictedCount: number) => {
	const base = `Layer request queued: ${parts.join(', ')}. You have ${ownCount} request${ownCount !== 1 ? 's' : ''} queued`
	return {
		warn: () =>
			evictedCount > 0
				? `${base} (your oldest ${evictedCount === 1 ? 'request was' : `${evictedCount} requests were`} dropped to make room).`
				: `${base}.`,
	}
})

export const noSolutions = Msgs.def((request: string) => ({
	warn: () => `No layers in the current pool match "${request}".`,
}))

export const backburnerFull = Msgs.def((max: number) => ({
	warn: () => `The layer request list is full (max ${max}).`,
}))

export const removed = Msgs.def((description: string) => ({
	warn: () => `Removed layer request: ${description}`,
}))

export const empty = Msgs.def(() => ({ warn: () => 'No layer requests queued.' }))
