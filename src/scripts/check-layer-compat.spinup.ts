import { execSync, exec, ChildProcess } from 'child_process'
import Rcon from '@/lib/rcon/rcon-core'
import SquadRcon from '@/lib/rcon/squad-rcon'
import { baseLogger, setupLogger } from '@/server/logger'
import * as M from '@/models'
import * as C from '@/server/context'
import { setupEnv } from '@/server/env'
import { sleep } from '@/lib/async'
import { execSync } from 'child_process'
import Docker, { ContainerInspectInfo } from 'dockerode'

const NUM_CONTAINERS = Number(process.argv[2]) || 1

// Function to find available port range
function findAvailablePorts(startPort: number, count: number): number[] {
	const availablePorts: number[] = []
	let currentPort = startPort

	while (availablePorts.length < count) {
		try {
			// Try to check if port is in use using netstat
			execSync(`netstat -an | grep ${currentPort}`)
			currentPort++
		} catch {
			// If command fails, port is available
			let isContiguous = true
			// Check if we can get enough contiguous ports from here
			for (let i = 0; i < count; i++) {
				try {
					execSync(`netstat -an | grep ${currentPort + i}`)
					isContiguous = false
					break
				} catch {
					continue
				}
			}

			if (isContiguous) {
				for (let i = 0; i < count; i++) {
					availablePorts.push(currentPort + i)
				}
			} else {
				currentPort++
			}
		}
	}

	return availablePorts
}
const containers: Docker.Container[] = []
async function main() {
	const ports: number[] = []

	setupEnv()
	setupLogger()
	const ctx = { log: baseLogger }
	const docker = new Docker({ socketPath: '/var/run/docker.sock' })
	ctx.log.info('Finding available ports...')
	ports.push(...findAvailablePorts(3000, NUM_CONTAINERS))
	ctx.log.info(`Found ports: ${ports.join(', ')}`)

	// Create volumes and spin up containers
	ctx.log.info('Starting containers...')
	for (let i = 0; i < NUM_CONTAINERS; i++) {
		const containerName = getContainerName(i)
		const container = docker.getContainer(containerName)
		let containerStatus = await getContainerStatus(ctx, container)
		if (!containerStatus) {
			execSync(`docker run -d -p ${ports[i]}:21114 --name ${containerName} layer-compat/commit:v1`)
			containerStatus = await getContainerStatus(ctx, container)!
		} else {
			// container.attach({ stdout: true, stderr: true }, (err, stream) => {})
		}
		if (!containerStatus) {
			throw new Error('Container not found')
		}
		console.log(containerStatus)
		if (!containerStatus.State.Running) {
			await container.start()
		}
		containers.push(container)
	}

	while (true) {
		await sleep(10_000)
	}
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

main().catch(console.error)

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
