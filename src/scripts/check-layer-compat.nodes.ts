import { $ } from 'zx'
import Rcon from '@/lib/rcon/rcon-core'
import SquadRcon from '@/lib/rcon/squad-rcon'
import { baseLogger, setupLogger } from '@/server/logger'
import * as M from '@/models'
import * as C from '@/server/context'
import { ensureEnvSetup } from '@/server/env'
import { sleep } from '@/lib/async'
import Docker, { ContainerInspectInfo } from 'dockerode'

const NUM_CONTAINERS = Number(process.argv[3]) || 1

const containers: Docker.Container[] = []
async function spinUp() {
	const ports: number[] = []

	ensureEnvSetup()
	await setupLogger()

	const ctx = { log: baseLogger }
	const docker = new Docker({ socketPath: '/var/run/docker.sock' })
	ctx.log.info('Finding available ports...')
	ports.push(...(await findAvailablePorts('localhost', 3000, NUM_CONTAINERS)))
	ctx.log.info(`Found ports: ${ports.join(', ')}`)

	// Create volumes and spin up containers
	ctx.log.info('Starting containers...')
	for (let i = 0; i < NUM_CONTAINERS; i++) {
		const containerName = getContainerName(i)
		const container = docker.getContainer(containerName)
		let containerStatus = await getContainerStatus(ctx, container)
		if (!containerStatus) {
			ctx.log.info(`Creating container ${containerName}...`)
			await $`docker run -d -p ${ports[i]}:21114 --name ${containerName} layer-compat/commit:v1`
			containerStatus = await getContainerStatus(ctx, container)!
		} else {
			// container.attach({ stdout: true, stderr: true }, (err, stream) => {})
		}
		if (!containerStatus) {
			throw new Error('Container not found')
		}
		if (!containerStatus.State.Running) {
			await container.start()
		}
		containers.push(container)
	}

	while (true) {
		await sleep(10_000)
	}
}

// https://stackoverflow.com/questions/9609130/efficiently-test-if-a-port-is-open-on-linux
export async function isPortOpen(host: string, port: number): Promise<boolean> {
	try {
		await $`bash -c "exec 6<>/dev/tcp/${host}/${port} 2>/dev/null && echo 'open' || echo 'closed'"`
		return true
	} catch {
		return false
	} finally {
		await $`exec 6>&-`
		await $`exec 6<&-`
	}
}

async function findAvailablePorts(host: string, startPort: number, count: number): Promise<number[]> {
	const availablePorts: number[] = []
	let currentPort = startPort
	const MAX_PORT = 65535

	while (availablePorts.length < count && count < MAX_PORT) {
		if (await isPortOpen(host, currentPort)) {
			availablePorts.push(currentPort)
		} else {
			availablePorts.length = 0
		}
		currentPort++
	}

	return availablePorts
}
function getContainerStatus(ctx: C.Log, container: Docker.Container) {
	return new Promise<Docker.ContainerInspectInfo | undefined>((resolve, reject) => {
		container.inspect((err, data) => {
			if (err) {
				ctx.log.error(err)
				resolve(undefined)
			} else {
				resolve(data)
			}
		})
	})
}
// Helper functions to get container and volume names
function getContainerName(index: number): string {
	return `layer-compat-commit-${index + 1}`
}

function getVolumeName(index: number): string {
	return `test-volume-${index + 1}`
}

spinUp().catch((err) => {
	console.error(err, 'error')
	process.exit(1)
})

// Stop containers on process termination
process.on('SIGINT', async () => {
	console.log('Stopping containers...')
	try {
		for (const container of containers) {
			await container.stop()
		}
		console.log('Containers stopped')
		process.exit(0)
	} catch (error) {
		console.error('Error stopping containers:', error)
		process.exit(1)
	}
})

process.on('SIGTERM', async () => {
	console.log('Stopping containers...')
	try {
		for (const container of containers) {
			await container.stop()
		}
		console.log('Containers stopped')
		process.exit(0)
	} catch (error) {
		console.error('Error stopping containers:', error)
		process.exit(1)
	}
})
