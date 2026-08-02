import { describe, expect, it } from 'vitest'

import * as L from './layer'

describe('getLayerCommand', () => {
	const testLayers = [
		'RAW:Gorodok_FRAAS_v1 RGF+CombinedArms ADF+Mechanized',
		'RAW:Kokan_FRAAS_v1 VDV+CombinedArms TLF+CombinedArms',
		'RAW:Kamdesh_TC_v1 BAF+Mechanized PLA+Motorized',
		'RAW:Logar_FRAAS_v1 GFI+CombinedArms RGF+CombinedArms',
		'RAW:Narva_FRAAS_v1 CAF+CombinedArms RGF+CombinedArms',
		'RAW:AlBasrah_Invasion_v2 USMC+Support MEI+Mechanized',
		'RAW:Harju_AAS_v3 ADF+CombinedArms RGF+CombinedArms',
		'RAW:BlackCoast_FRAAS_v1 CAF+Motorized PLA+CombinedArms',
		'RAW:Mestia_TC_v1 USMC+CombinedArms VDV+CombinedArms',
		'RAW:Fallujah_FRAAS_v2 GFI+Mechanized RGF+Mechanized',
		'RAW:FoolsRoad_AAS_v2 WPMC+CombinedArms IMF+CombinedArms',
		'RAW:GooseBay_AAS_v1 USMC+Motorized PLA+CombinedArms',
		'RAW:Chora_FRAAS_v1 USA+CombinedArms RGF+CombinedArms',
		'RAW:Manicouagan_AAS_v1 WPMC+CombinedArms CRF+CombinedArms',
		'RAW:Sumari_FRAAS_v1 USMC+CombinedArms RGF+CombinedArms',
		'RAW:Sanxian_FRAAS_v1 PLA+Support RGF+Support',
	]

	describe('with set-next command type', () => {
		it('handles raw layer ids correctly', () => {
			const result = L.getLayerCommand(testLayers[0], 'set-next')
			expect(result).toBe('AdminSetNextLayer Gorodok_RAAS_v1 RGF+CombinedArms ADF+Mechanized')
		})

		it('replaces FRAAS with RAAS in output', () => {
			testLayers.forEach((layer) => {
				const result = L.getLayerCommand(layer, 'set-next')
				expect(result).not.toContain('FRAAS')
				if (layer.includes('FRAAS')) {
					expect(result).toContain('RAAS')
				}
			})
		})

		it('includes AdminSetNextLayer prefix', () => {
			testLayers.forEach((layer) => {
				const result = L.getLayerCommand(layer, 'set-next')
				expect(result).toMatch(/^AdminSetNextLayer/)
			})
		})

		it('preserves faction and unit information', () => {
			const result = L.getLayerCommand('RAW:Kokan_FRAAS_v1 VDV+CombinedArms TLF+CombinedArms', 'set-next')
			expect(result).toBe('AdminSetNextLayer Kokan_RAAS_v1 VDV+CombinedArms TLF+CombinedArms')
		})
	})

	describe('with change-layer command type', () => {
		it('handles raw layer ids correctly', () => {
			const result = L.getLayerCommand(testLayers[1], 'change-layer')
			expect(result).toBe('AdminChangeLayer Kokan_RAAS_v1 VDV+CombinedArms TLF+CombinedArms')
		})

		it('includes AdminChangeLayer prefix', () => {
			testLayers.forEach((layer) => {
				const result = L.getLayerCommand(layer, 'change-layer')
				expect(result).toMatch(/^AdminChangeLayer/)
			})
		})

		it('handles invasion layers correctly', () => {
			const result = L.getLayerCommand('RAW:AlBasrah_Invasion_v2 USMC+Support MEI+Mechanized', 'change-layer')
			expect(result).toBe('AdminChangeLayer AlBasrah_Invasion_v2 USMC+Support MEI+Mechanized')
		})

		it('handles TC (Territory Control) layers correctly', () => {
			const result = L.getLayerCommand('RAW:Kamdesh_TC_v1 BAF+Mechanized PLA+Motorized', 'change-layer')
			expect(result).toBe('AdminChangeLayer Kamdesh_TC_v1 BAF+Mechanized PLA+Motorized')
		})
	})

	describe('with none command type', () => {
		it('returns only layer arguments without command prefix', () => {
			const result = L.getLayerCommand(testLayers[2], 'none')
			expect(result).toBe('Kamdesh_TC_v1 BAF+Mechanized PLA+Motorized')
		})

		it('still replaces FRAAS with RAAS', () => {
			const result = L.getLayerCommand('RAW:Gorodok_FRAAS_v1 RGF+CombinedArms ADF+Mechanized', 'none')
			expect(result).toBe('Gorodok_RAAS_v1 RGF+CombinedArms ADF+Mechanized')
		})

		it('handles all test layers correctly', () => {
			testLayers.forEach((layer) => {
				const result = L.getLayerCommand(layer, 'none')
				expect(result).not.toMatch(/^Admin/)
				expect(result.trim()).toBeTruthy()
			})
		})
	})

	describe('edge cases and validation', () => {
		it('handles layers with different unit types', () => {
			const mechanizedResult = L.getLayerCommand('RAW:Fallujah_FRAAS_v2 GFI+Mechanized RGF+Mechanized', 'set-next')
			expect(mechanizedResult).toContain('+Mechanized')

			const motorizedResult = L.getLayerCommand('RAW:BlackCoast_FRAAS_v1 CAF+Motorized PLA+CombinedArms', 'set-next')
			expect(motorizedResult).toContain('+Motorized')

			const supportResult = L.getLayerCommand('RAW:Sanxian_FRAAS_v1 PLA+Support RGF+Support', 'set-next')
			expect(supportResult).toContain('+Support')
		})

		it('handles layers with different factions', () => {
			const usaResult = L.getLayerCommand('RAW:Chora_FRAAS_v1 USA+CombinedArms RGF+CombinedArms', 'change-layer')
			expect(usaResult).toContain('USA+')

			const plaResult = L.getLayerCommand('RAW:GooseBay_AAS_v1 USMC+Motorized PLA+CombinedArms', 'change-layer')
			expect(plaResult).toContain('PLA+')

			const cafResult = L.getLayerCommand('RAW:Narva_FRAAS_v1 CAF+CombinedArms RGF+CombinedArms', 'change-layer')
			expect(cafResult).toContain('CAF+')
		})

		it('normalizes whitespace in output', () => {
			testLayers.forEach((layer) => {
				const result = L.getLayerCommand(layer, 'set-next')
				expect(result).not.toMatch(/\s{2,}/) // No multiple consecutive spaces
				expect(result).not.toMatch(/^\s|\s$/) // No leading or trailing spaces
			})
		})

		it('preserves layer versions correctly', () => {
			const v1Result = L.getLayerCommand('RAW:Gorodok_FRAAS_v1 RGF+CombinedArms ADF+Mechanized', 'none')
			expect(v1Result).toContain('_v1')

			const v2Result = L.getLayerCommand('RAW:Fallujah_FRAAS_v2 GFI+Mechanized RGF+Mechanized', 'none')
			expect(v2Result).toContain('_v2')

			const v3Result = L.getLayerCommand('RAW:Harju_AAS_v3 ADF+CombinedArms RGF+CombinedArms', 'none')
			expect(v3Result).toContain('_v3')
		})
	})

	describe('different gamemode types', () => {
		it('handles AAS (Advance and Secure) layers', () => {
			const result = L.getLayerCommand('RAW:FoolsRoad_AAS_v2 WPMC+CombinedArms IMF+CombinedArms', 'set-next')
			expect(result).toBe('AdminSetNextLayer FoolsRoad_AAS_v2 WPMC+CombinedArms IMF+CombinedArms')
		})

		it('handles TC (Territory Control) layers', () => {
			const result = L.getLayerCommand('RAW:Mestia_TC_v1 USMC+CombinedArms VDV+CombinedArms', 'change-layer')
			expect(result).toBe('AdminChangeLayer Mestia_TC_v1 USMC+CombinedArms VDV+CombinedArms')
		})

		it('handles Invasion layers', () => {
			const result = L.getLayerCommand('RAW:AlBasrah_Invasion_v2 USMC+Support MEI+Mechanized', 'none')
			expect(result).toBe('AlBasrah_Invasion_v2 USMC+Support MEI+Mechanized')
		})

		it('handles FRAAS/RAAS layers with conversion', () => {
			const result = L.getLayerCommand('RAW:Sumari_FRAAS_v1 USMC+CombinedArms RGF+CombinedArms', 'set-next')
			expect(result).toBe('AdminSetNextLayer Sumari_RAAS_v1 USMC+CombinedArms RGF+CombinedArms')
		})
	})

	describe('all command type permutations', () => {
		const sampleLayer = 'RAW:Logar_FRAAS_v1 GFI+CombinedArms RGF+CombinedArms'
		const expectedBase = 'Logar_RAAS_v1 GFI+CombinedArms RGF+CombinedArms'

		it('set-next command permutation', () => {
			const result = L.getLayerCommand(sampleLayer, 'set-next')
			expect(result).toBe(`AdminSetNextLayer ${expectedBase}`)
		})

		it('change-layer command permutation', () => {
			const result = L.getLayerCommand(sampleLayer, 'change-layer')
			expect(result).toBe(`AdminChangeLayer ${expectedBase}`)
		})

		it('none command permutation', () => {
			const result = L.getLayerCommand(sampleLayer, 'none')
			expect(result).toBe(expectedBase)
		})
	})

	describe('comprehensive test of all provided layers', () => {
		it('processes all test layers without errors', () => {
			testLayers.forEach((layer, _index) => {
				expect(() => {
					const setNextResult = L.getLayerCommand(layer, 'set-next')
					const changeLayerResult = L.getLayerCommand(layer, 'change-layer')
					const noneResult = L.getLayerCommand(layer, 'none')

					// Basic validation
					expect(setNextResult).toBeTruthy()
					expect(changeLayerResult).toBeTruthy()
					expect(noneResult).toBeTruthy()

					// Command prefix validation
					expect(setNextResult).toMatch(/^AdminSetNextLayer/)
					expect(changeLayerResult).toMatch(/^AdminChangeLayer/)
					expect(noneResult).not.toMatch(/^Admin/)
				}).not.toThrow()
			})
		})

		it('ensures consistent FRAAS to RAAS conversion across all layers', () => {
			const fraasLayers = testLayers.filter((layer) => layer.includes('FRAAS'))

			fraasLayers.forEach((layer) => {
				const result = L.getLayerCommand(layer, 'set-next')
				expect(result).toContain('RAAS')
				expect(result).not.toContain('FRAAS')
			})
		})

		describe('bug documentation and edge case testing', () => {
			// Note: The bug has been fixed! The early return now works correctly.
			// Previously: `if (layerOrId === 'string' && layerOrId.startsWith('RAW'))`
			// Fixed to: `if (typeof layerOrId === 'string' && layerOrId.startsWith('RAW'))`

			it('demonstrates the early return now works correctly with raw layer strings', () => {
				const rawLayer = 'RAW:TestLayer_AAS_v1 USA+Infantry RUS+Infantry'

				// With the bug fixed, this now properly uses the early return optimization
				const result = L.getLayerCommand(rawLayer, 'set-next')

				// The function works correctly and efficiently
				expect(result).toBe('AdminSetNextLayer TestLayer_AAS_v1 USA+Infantry RUS+Infantry')
			})

			it('confirms that raw layers are processed correctly after the bug fix', () => {
				// With the bug fixed, RAW layers are handled properly via the early return
				testLayers.forEach((rawLayer) => {
					expect(() => {
						L.getLayerCommand(rawLayer, 'set-next')
						L.getLayerCommand(rawLayer, 'change-layer')
						L.getLayerCommand(rawLayer, 'none')
					}).not.toThrow()
				})
			})

			it('handles valid raw layers properly', () => {
				// Test with valid but simple raw layers
				const validEdgeCases = ['RAW:TestMap_AAS_v1 USA+Infantry RUS+Infantry', 'RAW:AnotherMap_TC_v2 PLA+Mechanized USA+Motorized']

				validEdgeCases.forEach((edgeCase) => {
					expect(() => {
						L.getLayerCommand(edgeCase, 'none')
					}).not.toThrow()
				})
			})
		})
	})
})

describe('mod source layers', () => {
	const supermodLayer = 'SU_Sanxian_Invasion_v2'

	function firstMatchup(layer: string) {
		const avail = L.StaticLayerComponents.layerFactionAvailability[layer]
		const team1 = avail.find((e) => e.allowedTeams.includes(1))!
		const team2 = avail.find((e) => e.allowedTeams.includes(2) && e.Faction !== team1.Faction)!
		return { team1, team2 }
	}

	// mod map names contain underscores, which the Map_Gamemode_vN convention cannot express: reading SU_Sanxian_Invasion_v2
	// positionally yields Map "SU", Gamemode "Sanxian" and no version
	it('segments a mod layer string from the catalog rather than its shape', () => {
		const segments = L.parseLayerStringSegment(supermodLayer)!
		expect(segments.Map).toBe('Supermod_Sanxian')
		expect(segments.Gamemode).toBe('Invasion')
		expect(segments.LayerVersion).toBe('V2')
		expect(segments.Collection).toBe('SuperMod')
	})

	it('segments every catalogued layer to the same values the catalog holds', () => {
		const mismatched = L.StaticLayerComponents.mapLayers.filter((config) => {
			const segments = L.parseLayerStringSegment(config.Layer)
			return (
				segments?.Map !== config.Map ||
				segments.Gamemode !== config.Gamemode ||
				segments.LayerVersion !== config.LayerVersion ||
				segments.Collection !== L.layerConfigCollection(config)
			)
		})
		expect(mismatched.map((config) => config.Layer)).toEqual([])
	})

	it('resolves a supermod RCON string to a known layer', () => {
		const { team1, team2 } = firstMatchup(supermodLayer)
		const raw = `${supermodLayer} ${team1.Faction}+${team1.Unit} ${team2.Faction}+${team2.Unit}`
		const layer = L.parseRawLayerText(raw)!
		expect(L.isRawLayer(layer)).toBe(false)
		expect(layer.Layer).toBe(supermodLayer)
		expect(layer.Gamemode).toBe('Invasion')
		expect(layer.Collection).toBe('SuperMod')
	})

	it('round-trips a supermod layer id', () => {
		const { team1, team2 } = firstMatchup(supermodLayer)
		const id = L.getKnownLayerId({
			Map: 'Supermod_Sanxian',
			Gamemode: 'Invasion',
			LayerVersion: 'V2',
			Collection: 'SuperMod',
			Faction_1: team1.Faction,
			Unit_1: team1.Unit,
			Faction_2: team2.Faction,
			Unit_2: team2.Unit,
		})!
		expect(id).not.toBeNull()
		const res = L.parseLayerId(id)
		if (res.code !== 'ok') throw new Error(`expected ok, got ${res.code}`)
		expect(res.layer.Layer).toBe(supermodLayer)
		expect(res.layer.Faction_1).toBe(team1.Faction)
	})

	it('emits the exact layer string in commands, not a reconstruction', () => {
		const { team1, team2 } = firstMatchup(supermodLayer)
		const raw = `${supermodLayer} ${team1.Faction}+${team1.Unit} ${team2.Faction}+${team2.Unit}`
		const layer = L.parseRawLayerText(raw)!
		expect(L.getLayerCommand(layer, 'set-next')).toBe(`AdminSetNextLayer ${raw}`)
	})

	it('sends bare commands for mod training layers', () => {
		const layer = L.parseRawLayerText('SU_JensensRange_ADF')!
		expect(layer.Gamemode).toBe('Training')
		expect(L.getLayerCommand(layer, 'set-next')).toBe('AdminSetNextLayer SU_JensensRange_ADF')
	})
})

describe('the Community collection, folded into OWI', () => {
	const layer = 'Fallujah_Invasion_v3_CL'

	function firstMatchup(layerString: string) {
		const avail = L.StaticLayerComponents.layerFactionAvailability[layerString]
		const team1 = avail.find((e) => e.allowedTeams.includes(1))!
		const team2 = avail.find((e) => e.allowedTeams.includes(2) && e.Faction !== team1.Faction)!
		return { team1, team2 }
	}

	function idOf(layerString: string) {
		const config = L.getLayerConfig(layerString)!
		const { team1, team2 } = firstMatchup(layerString)
		return L.getKnownLayerId({
			Map: config.Map,
			Gamemode: config.Gamemode,
			LayerVersion: config.LayerVersion,
			Collection: L.layerConfigCollection(config),
			Faction_1: team1.Faction,
			Unit_1: team1.Unit,
			Faction_2: team2.Faction,
			Unit_2: team2.Unit,
		})!
	}

	it('is not a collection any more', () => {
		expect(L.StaticLayerComponents.collections).not.toContain('Community')
	})

	it('puts its layers in OWI, so their ids carry no collection segment', () => {
		expect(L.layerConfigCollection(L.getLayerConfig(layer)!)).toBe('OWI')
		expect(idOf(layer)).not.toContain('-CL:')
	})

	it('resolves an id persisted with the old CL segment to the current one', () => {
		const id = idOf(layer)
		const res = L.parseLayerId(id.replace(/^([^:]+)/, '$1-CL'))
		if (res.code !== 'ok') throw new Error(`expected ok, got ${res.code}`)
		expect(res.layer.id).toBe(id)
		expect(res.layer.Collection).toBe('OWI')
		expect(res.layer.Layer).toBe(layer)
	})

	it('still rejects an id whose collection segment means nothing', () => {
		const id = idOf(layer)
		expect(L.parseLayerId(id.replace(/^([^:]+)/, '$1-ZZ')).code).not.toBe('ok')
	})
})
