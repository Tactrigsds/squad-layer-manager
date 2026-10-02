import { describe, expect, it } from 'vitest'

import * as SR from '@/models/squad-rcon.models'

const IDS = 'EOS: 000249a430574933aefd9bbc9a8f2f37 steam: 76561198052229202'

function body(...activeRows: string[]) {
	return [
		'----- Active Players -----',
		...activeRows,
		'----- Recently Disconnected Players [Max of 15] -----',
		`ID: 7 | Online IDs: ${IDS} | Since Disconnect: 00m.30s | Name: gone`,
	].join('\n')
}

describe('parseListPlayers', () => {
	it('reads the pre-October 2026 format, keeping the leading space in the name', () => {
		const res = SR.parseListPlayers(
			body(`ID: 0 | Online IDs: ${IDS} | Name:  grey275 | Team ID: 2 | Squad ID: 1 | Is Leader: True | Role: PLA_Recruit`),
		)
		expect(res.unmatched).toEqual([])
		expect(res.rows).toEqual([
			{
				playerID: 0,
				idsStr: ` ${IDS} `,
				name: ' grey275',
				teamId: 2,
				squadId: 1,
				isLeader: true,
				role: 'PLA_Recruit',
				partyId: null,
				vehicle: null,
			},
		])
	})

	it('reads the October 2026 format, with its party and vehicle', () => {
		const res = SR.parseListPlayers(
			body(
				`ID: 14 | Online IDs: ${IDS} | Name:  grey275 | Team ID: 2 | Party ID: N/A | Squad ID: N/A | Is Leader: False | Role: MEI_Rifleman_01 | Vehicle: minsk400 (Driver)`,
				`ID: 24 | Online IDs: ${IDS} | Name: a | Team ID: 1 | Party ID: #0 | Squad ID: 2 | Is Leader: False | Role: WPMC_Rifleman_01 | Vehicle: N/A`,
			),
		)
		expect(res.unmatched).toEqual([])
		expect(res.rows.map((r) => [r.name, r.squadId, r.role, r.partyId, r.vehicle])).toEqual([
			[' grey275', null, 'MEI_Rifleman_01', null, 'minsk400 (Driver)'],
			['a', 2, 'WPMC_Rifleman_01', '#0', null],
		])
	})

	it('reads rows with fields it does not know about', () => {
		const res = SR.parseListPlayers(
			body(
				`ID: 0 | Online IDs: ${IDS} | Name: a | Team ID: 1 | Squad ID: 2 | Unknown: x | Is Leader: False | Role: USA_Rifleman_01 | Later: y`,
			),
		)
		expect(res.unmatched).toEqual([])
		expect(res.rows.map((r) => [r.name, r.squadId, r.role])).toEqual([['a', 2, 'USA_Rifleman_01']])
	})

	it('keeps " | " inside a name', () => {
		const res = SR.parseListPlayers(
			body(`ID: 0 | Online IDs: ${IDS} | Name: [TT] | grey | Team ID: N/A | Squad ID: N/A | Is Leader: False | Role: x`),
		)
		expect(res.rows[0]).toMatchObject({ name: '[TT] | grey', teamId: null })
	})

	it('reports active rows it cannot read and skips the disconnected section', () => {
		const bad = `ID: 0 | Online IDs: ${IDS} | Name: a | Team: 1 | Squad ID: 2 | Is Leader: False | Role: x`
		const res = SR.parseListPlayers(body(bad))
		expect(res.rows).toEqual([])
		expect(res.unmatched).toEqual([bad])
	})
})
