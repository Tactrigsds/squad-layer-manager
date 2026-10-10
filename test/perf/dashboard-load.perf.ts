import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

import { makePlayer } from '@/emulator/world'

import { createAppFixture } from '../harness/app-fixture'
import { teamsLabel, teamsSection } from '../harness/dashboard'
import { summarizeProfile } from './profile-summary'

// A live dashboard on a full, busy server: 90 players in 16 squads, PERF_KILLS_PER_SEC kills (a wound and a death each)
// and PERF_CHATS_PER_SEC chat lines, with the CPU throttled by PERF_THROTTLE to stand in for a weaker machine. Records
// a CPU profile of PERF_WINDOW_MS of it.

const PLAYERS = 90
const SQUADS = 16
const THROTTLE = Number(process.env.PERF_THROTTLE ?? 4)
const WINDOW_MS = Number(process.env.PERF_WINDOW_MS ?? 30_000)
const KILLS_PER_SEC = Number(process.env.PERF_KILLS_PER_SEC ?? 4)
const CHATS_PER_SEC = Number(process.env.PERF_CHATS_PER_SEC ?? 1)
const OUT_DIR = path.resolve(process.env.PERF_OUT ?? 'perf-results', process.env.PERF_LABEL ?? 'dashboard-load')

test('dashboard under combat and chat load', async ({ page }) => {
	const app = await createAppFixture()
	try {
		const world = app.emu.world
		const players = Array.from({ length: PLAYERS }, (_, i) =>
			world.connectPlayer(makePlayer({ name: `Perf${i + 1}`, teamId: ((i % 2) + 1) as 1 | 2 })),
		)
		for (let s = 0; s < SQUADS; s++) {
			const leader = players[s]
			const squad = world.createSquad(leader, `SQ${s + 1}`)
			for (let i = SQUADS + s; i < PLAYERS; i += SQUADS) {
				if (players[i].teamId === leader.teamId) world.joinSquad(players[i], squad)
			}
		}

		await app.waitForRosterSync()
		await page.goto(app.loginUrl(undefined, `/servers/${app.serverId}`))
		await expect(teamsLabel(page, new RegExp(`\\(${PLAYERS}\\)`))).toBeVisible({ timeout: 60_000 })
		const teamsTab = page.getByRole('tab', { name: /^Teams(?! Breakdown)/ })
		if ((await teamsTab.count()) > 0) await teamsTab.click()
		await expect(teamsSection(page)).toBeVisible()

		const cdp = await page.context().newCDPSession(page)
		if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
		await page.waitForTimeout(5_000)

		await page.evaluate(() => {
			const g = globalThis as any
			g.__perfLongTasks = { count: 0, ms: 0 }
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) {
					g.__perfLongTasks.count++
					g.__perfLongTasks.ms += e.duration
				}
			}).observe({ entryTypes: ['longtask'] })
		})
		await cdp.send('Profiler.enable')
		await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
		await cdp.send('Profiler.start')

		const team1 = players.filter((p) => p.teamId === 1)
		const team2 = players.filter((p) => p.teamId === 2)
		// seeded, so every run plays the same match
		let seed = 0x9e3779b9
		const random = () => {
			seed = (seed + 0x6d2b79f5) | 0
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}
		const pick = <T>(arr: T[]) => arr[Math.floor(random() * arr.length)]
		const timers = [
			setInterval(() => {
				const [victim, attacker] = random() < 0.5 ? [pick(team1), pick(team2)] : [pick(team2), pick(team1)]
				world.woundPlayer(victim, attacker)
				world.killPlayer(victim, attacker)
			}, 1000 / KILLS_PER_SEC),
			setInterval(() => world.chat(pick(players), 'ChatAll', `perf ${random().toString(36).slice(2)}`), 1000 / CHATS_PER_SEC),
		]
		await page.waitForTimeout(WINDOW_MS)
		for (const t of timers) clearInterval(t)

		const { profile } = await cdp.send('Profiler.stop')
		const longTasks = await page.evaluate(() => (globalThis as any).__perfLongTasks)
		fs.mkdirSync(OUT_DIR, { recursive: true })
		fs.writeFileSync(path.join(OUT_DIR, 'profile.cpuprofile'), JSON.stringify(profile))
		const summary = await summarizeProfile(profile, { distDir: path.resolve('dist') })
		const header = `throttle ${THROTTLE}x, ${KILLS_PER_SEC} kills/s, ${CHATS_PER_SEC} chats/s, window ${WINDOW_MS}ms\nlong tasks: ${longTasks.count}, ${Math.round(longTasks.ms)}ms\n`
		fs.writeFileSync(path.join(OUT_DIR, 'summary.txt'), header + summary)
		console.log(header + summary)
	} finally {
		await app.dispose()
	}
})
