import { formatVersion } from '@/lib/versioning.ts'

import * as Env from '@/server/env'
import * as Cleanup from '@/systems/cleanup.server'
import { instanceId } from '@/systems/otel.server'
import Pyroscope from '@pyroscope/nodejs'

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.pyroscope })

export function setupPyroscope() {
	const ENV = envBuilder()
	console.log('Setting up Pyroscope profiling...')

	Pyroscope.init({
		appName: 'squad-layer-manager',
		serverAddress: ENV.PYROSCOPE_ENDPOINT,
		// the same three dimensions the otel resource carries, so a profile lines up with the traces and
		// logs from the same process (see ATTR_SERVICE_* in otel.server).
		tags: {
			branch: ENV.PUBLIC_GIT_BRANCH,
			version: formatVersion(ENV.PUBLIC_GIT_BRANCH, ENV.PUBLIC_GIT_SHA),
			service_instance_id: instanceId,
		},
		wall: { collectCpuTime: true },
	})

	Pyroscope.startWallProfiling()
	if (ENV.PYROSCOPE_HEAP_ENABLED) Pyroscope.startHeapProfiling()

	Cleanup.register(() => Pyroscope.stop())

	console.log(`Pyroscope profiling started -> ${ENV.PYROSCOPE_ENDPOINT} (heap: ${ENV.PYROSCOPE_HEAP_ENABLED})`)
}
