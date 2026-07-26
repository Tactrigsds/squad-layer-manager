import * as Msgs from '@/messages/shared'

export const fogOff = Msgs.def(() => ({
	broadcast: () => 'Fog of War is disabled. All points are visible. Check your maps.',
}))

export const slmUpdatesSet = Msgs.def((enabled: boolean) => ({
	warn: () => `Updates from SLM have been ${enabled ? 'enabled' : 'disabled'}.`,
}))

export const slmUpdatesStatus = Msgs.def((enabled: boolean) => ({
	warn: () => `Updates from SLM are ${enabled ? 'enabled' : 'disabled'}.`,
}))

export const slmStarted = Msgs.def((restartedBy?: string) => ({
	warn: () => (restartedBy ? `SLM has been restarted by ${restartedBy}.` : `SLM has been started.`),
}))
