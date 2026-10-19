import { describe, expect, it } from 'vitest'

import { z } from '@/lib/zod'

import * as LC from './layer-columns.models'
import * as L from './layer.models'

// an id in the abbreviated format SLM wrote before canonical text, which stored data can still hold
function legacyIdOf(layer: L.KnownLayer, components = L.StaticLayerComponents) {
	let head = `${components.mapAbbreviations[layer.Map]}-${components.gamemodeAbbreviations[layer.Gamemode]}`
	if (layer.LayerVersion) head += `-${layer.LayerVersion}`
	if (layer.Collection !== L.getDefaultCollection(components)) head += `-${components.collectionAbbreviations[layer.Collection]}`
	const team = (faction: string, unit: string) => `${faction}-${components.unitAbbreviations[unit]}`
	return `${head}:${team(layer.Faction_1, layer.Unit_1)}:${team(layer.Faction_2, layer.Unit_2)}`
}

describe('layer ids', () => {
	const NARVA = 'Narva_RAAS_v1:USA+CombinedArms:RGF+CombinedArms'
	// a layer the layer data has no config for, such as one from a mod this build was not given
	const UNKNOWN = 'Nowhere_RAAS_v1:USA+CombinedArms:RGF+CombinedArms'

	it('gives a layer the layer data holds its dense id, which round-trips through canonical text', () => {
		const id = L.fromLayerText(NARVA)!
		expect(L.isDenseLayerId(id)).toBe(true)
		expect(L.toLayerText(id)).toBe(NARVA)
		expect(L.fromLayerText(L.toLayerText(id))).toBe(id)
		expect(L.idFromParts(L.toLayer(id))).toBe(id)
	})

	it('keeps a layer the layer data does not hold as its text, with what parts can be read', () => {
		const id = L.fromLayerText(UNKNOWN)!
		expect(id).toBe(UNKNOWN)
		expect(L.isRawLayer(id)).toBe(true)
		expect(L.toLayer(id)).toMatchObject({ Layer: 'Nowhere_RAAS_v1', Faction_1: 'USA', Faction_2: 'RGF' })
		expect(L.normalize(id)).toBe(id)
	})

	it('fills in default units, so one layer spelled either way is one id', () => {
		expect(L.fromLayerText('Narva_RAAS_v1:USA:RGF')).toBe(L.fromLayerText(NARVA))
	})

	it('reads stored text in every format that has ever written it', () => {
		const id = L.fromLayerText(NARVA)!
		const known = L.toLayer(id) as L.KnownLayer
		expect(L.fromStoredLayerText(NARVA)).toBe(id)
		expect(L.fromStoredLayerText(legacyIdOf(known))).toBe(id)
		expect(L.fromStoredLayerText('RAW:Narva_RAAS_v1 USA+CombinedArms RGF+CombinedArms')).toBe(id)
	})

	it('keeps a legacy id it can only half read as the text it was written as', () => {
		expect(L.fromStoredLayerText('ZZ-RAAS-V1:USA-CA:RGF-CA')).toBe('ZZ-RAAS-V1:USA-CA:RGF-CA')
		const unknownUnit = legacyIdOf(L.toLayer(L.fromLayerText(NARVA)!) as L.KnownLayer).replace(':USA-CA:', ':USA-XX:')
		expect(L.fromStoredLayerText(unknownUnit)).toBe(unknownUnit)
		expect(L.readStoredLayerId('not a layer id at all')).toBe('not a layer id at all')
	})

	it('keeps a lone first team of a raw layer in its id', () => {
		const id = L.fromStoredLayerText('RAW:Narva_RAAS_v1 USA+CombinedArms')!
		expect(id).toBe('Narva_RAAS_v1:USA+CombinedArms')
		expect(L.toLayer(id)).toMatchObject({ Layer: 'Narva_RAAS_v1', Faction_1: 'USA', Unit_1: 'CombinedArms' })
		expect(L.fromLayerText(L.toLayerText(id))).toBe(id)
	})

	it('reads a FRAAS layer back from its plain command, and sends the game its RAAS name', () => {
		const id = L.fromLayerText('Narva_FRAAS_v1:USA+CombinedArms:RGF+CombinedArms')!
		expect(L.parseRawLayerText(L.getLayerCommand(id, 'none'))?.id).toBe(id)
		expect(L.getLayerCommand(id, 'set-next')).toBe('AdminSetNextLayer Narva_RAAS_v1 USA+CombinedArms RGF+CombinedArms')
	})

	it('decodes either form through LayerIdSchema and encodes to canonical text', () => {
		const id = L.fromLayerText(NARVA)!
		expect(L.LayerIdSchema.parse(id)).toBe(id)
		expect(L.LayerIdSchema.parse(NARVA)).toBe(id)
		expect(L.LayerIdSchema.parse(legacyIdOf(L.toLayer(id) as L.KnownLayer))).toBe(id)
		expect(L.LayerIdSchema.safeParse(2 ** 29 + 12345).success).toBe(false)
		expect(L.LayerIdSchema.safeParse(2 ** 32 + (id as number)).success).toBe(false)
		expect(z.encode(L.LayerIdSchema, id)).toBe(NARVA)
		expect(z.encode(z.array(L.LayerIdSchema), [id, L.fromLayerText(UNKNOWN)!])).toEqual([NARVA, UNKNOWN])
	})

	it('shares one frozen layer per id, which comparisons copy rather than edit', () => {
		const id = L.fromLayerText('Narva_FRAAS_v1:USA+CombinedArms:RGF+CombinedArms') ?? L.fromLayerText(NARVA)!
		const layer = L.toLayer(id)
		expect(L.toLayer(id)).toBe(layer)
		expect(Object.isFrozen(layer)).toBe(true)
		const before = layer.Layer
		L.areLayersPartialMatch(id, id, true)
		L.areLayersCompatible({ id, Layer: 'Narva_RAAS_v1' }, id)
		expect(layer.Layer).toBe(before)
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
		const layer = L.toLayer(id)
		expect(layer.Layer).toBe(supermodLayer)
		expect(layer.Faction_1).toBe(team1.Faction)
		expect(L.fromLayerText(L.toLayerText(id))).toBe(id)
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

	it('puts its layers in OWI', () => {
		expect(L.layerConfigCollection(L.getLayerConfig(layer)!)).toBe('OWI')
		expect(L.toLayer(idOf(layer)).Collection).toBe('OWI')
	})

	it('resolves a legacy id persisted with the old CL segment to the current layer', () => {
		const id = idOf(layer)
		const legacy = legacyIdOf(L.toLayer(id) as L.KnownLayer).replace(/^([^:]+)/, '$1-CL')
		const res = L.parseLegacyLayerId(legacy)
		if (res.code !== 'ok') throw new Error(`expected ok, got ${res.code}`)
		expect(res.layer.id).toBe(id)
		expect(res.layer.Collection).toBe('OWI')
		expect(res.layer.Layer).toBe(layer)
		expect(L.fromStoredLayerText(legacy)).toBe(id)
	})

	it('still rejects a legacy id whose collection segment means nothing', () => {
		const legacy = legacyIdOf(L.toLayer(idOf(layer)) as L.KnownLayer).replace(/^([^:]+)/, '$1-ZZ')
		expect(L.parseLegacyLayerId(legacy).code).not.toBe('ok')
	})
})

describe('parseRawLayerLines', () => {
	const vanilla = 'Narva_RAAS_v1 RGF USMC'
	const supermod = 'SU_Sanxian_Invasion_v2 SU_ADF SU_BAF'

	it('reports each line under its own 1-based number, blank lines included in the count', () => {
		const lines = L.parseRawLayerLines(`\n${vanilla}\n\n  \nnot a layer at all\n`)
		expect(lines.map((l) => [l.lineNumber, l.code])).toEqual([
			[2, 'ok'],
			[5, 'err:unparsable'],
		])
	})

	it.each([
		[
			'a layer, suggesting the closest catalog name',
			'Manicougan_AAS_v3 USA+LightInfantry PLANMC+CombinedArms',
			[{ code: 'unknown-layer', value: 'Manicougan_AAS_v3', suggestion: 'Manicouagan_AAS_v3' }],
		],
		['a gamemode', 'Narva_RASS_v1 RGF USMC', [{ code: 'unknown-layer', value: 'Narva_RASS_v1', suggestion: 'Narva_RAAS_v1' }]],
		['a faction', 'Narva_RAAS_v1 RFG USMC', [{ code: 'unknown-faction', team: 1, value: 'RFG', suggestion: 'RGF' }]],
		[
			'a unit',
			'Narva_RAAS_v1 RGF+CombindArms USMC',
			[{ code: 'unknown-unit', team: 1, value: 'CombindArms', suggestion: 'CombinedArms' }],
		],
		['a left-out faction', 'Narva_RAAS_v1 RGF', [{ code: 'missing-faction', team: 2 }]],
	])('flags a misspelled %s as unparsable, keeping the raw layer', (_, text, problems) => {
		const [line] = L.parseRawLayerLines(text)
		expect(line).toMatchObject({ code: 'err:unparsable', problems })
		expect(line.code === 'err:unparsable' && line.layer && L.isRawLayer(line.layer)).toBe(true)
	})

	it('names each misspelled part of one line', () => {
		const [line] = L.parseRawLayerLines('Narva_RAAS_v1 RFG USMC+CombindArms')
		expect(line).toMatchObject({
			code: 'err:unparsable',
			problems: [
				{ code: 'unknown-faction', team: 1, value: 'RFG' },
				{ code: 'unknown-unit', team: 2, value: 'CombindArms' },
			],
		})
	})

	it('flags a unit the faction cannot field on the layer as an unknown layer', () => {
		const [line] = L.parseRawLayerLines('Narva_RAAS_v1 RGF USMC+AirAssault')
		expect(line).toMatchObject({
			code: 'err:unknown-layer',
			problems: [{ code: 'unavailable-faction', team: 2, faction: 'USMC', unit: 'AirAssault' }],
		})
	})

	it('flags a faction against itself as an unknown layer', () => {
		const [line] = L.parseRawLayerLines('Narva_RAAS_v1 RGF RGF')
		expect(line).toMatchObject({ code: 'err:unknown-layer', problems: [{ code: 'mirror-matchup', faction: 'RGF' }] })
	})

	it('passes a modded layer when its collection is installed', () => {
		const [line] = L.parseRawLayerLines(supermod, { installedMods: ['OWI', 'SuperMod'] })
		expect(line.code).toBe('ok')
	})

	it('flags a modded layer when its collection is not, naming the collection', () => {
		const [line] = L.parseRawLayerLines(supermod, { installedMods: ['OWI'] })
		expect(line).toMatchObject({ code: 'err:mod-not-installed', collection: 'SuperMod' })
	})

	it('checks no collection when the caller names no server', () => {
		expect(L.parseRawLayerLines(supermod)[0].code).toBe('ok')
	})
})

describe('world partitioning layers', () => {
	const WP_LAYERS = ['Yehorivka_AAS_v1_WP', 'Yehorivka_Invasion_v1_WP', 'Yehorivka_RAAS_v1_WP', 'Yehorivka_Skirmish_v1_WP']

	// the checked-in catalog predates the WP layers, so each one is added as a copy of its base layer
	const base = L.StaticLayerComponents
	const components: typeof base = {
		...base,
		layers: [...base.layers, ...WP_LAYERS],
		versions: [...base.versions, 'V1WP'],
		mapLayers: [
			...base.mapLayers,
			...WP_LAYERS.map((layer) => ({ ...L.getLayerConfig(layer.replace(/_WP$/, ''), base)!, Layer: layer, LayerVersion: 'V1WP' })),
		],
		layerFactionAvailability: {
			...base.layerFactionAvailability,
			...Object.fromEntries(WP_LAYERS.map((layer) => [layer, base.layerFactionAvailability[layer.replace(/_WP$/, '')]])),
		},
	}

	function idOf(layerString: string) {
		const config = L.getLayerConfig(layerString, components)!
		const avail = components.layerFactionAvailability[layerString]
		const team1 = avail.find((e) => e.allowedTeams.includes(1))!
		const team2 = avail.find((e) => e.allowedTeams.includes(2) && e.Faction !== team1.Faction)!
		return L.getKnownLayerId(
			{
				Map: config.Map,
				Gamemode: config.Gamemode,
				LayerVersion: config.LayerVersion,
				Collection: L.layerConfigCollection(config, components),
				Faction_1: team1.Faction,
				Unit_1: team1.Unit,
				Faction_2: team2.Faction,
				Unit_2: team2.Unit,
			},
			components,
		)!
	}

	it('segments a WP layer string into its own version, with or without the catalog', () => {
		for (const c of [components, null]) {
			const segments = L.parseLayerStringSegment('Yehorivka_AAS_v1_WP', c)!
			expect(segments).toMatchObject({ Map: 'Yehorivka', Gamemode: 'AAS', LayerVersion: 'V1WP' })
		}
		expect(L.parseLayerStringSegment('Yehorivka_AAS_v1', null)!.LayerVersion).toBe('V1')
	})

	it.each(WP_LAYERS)('gives %s an id distinct from its base layer, which round-trips', (layer) => {
		const id = idOf(layer)
		expect(id).not.toBe(idOf(layer.replace(/_WP$/, '')))

		const known = L.toLayer(id, components) as L.KnownLayer
		expect(known.Layer).toBe(layer)
		expect(known.LayerVersion).toBe('V1WP')

		const command = L.getLayerCommand(known, 'set-next', components)
		expect(command).toContain(` ${layer} `)
		expect(L.parseRawLayerText(command, components)?.id).toBe(id)

		expect(LC.packId(known, components)).toBe(id)
		const legacy = legacyIdOf(known, components)
		expect(legacy).toMatch(/^YH-[A-Z]+-V1WP:/)
		expect(L.fromStoredLayerText(legacy, components)).toBe(id)
	})

	it('still resolves the base layer to itself', () => {
		expect(L.toLayer(idOf('Yehorivka_AAS_v1'), components).Layer).toBe('Yehorivka_AAS_v1')
	})

	it('spells the version back out as it appears in the layer name', () => {
		expect(L.layerVersionNameSegment('V1WP')).toBe('v1_WP')
		expect(L.layerVersionNameSegment('V1')).toBe('v1')
		expect(
			L.getLayerString(
				{ Map: 'Yehorivka', Gamemode: 'TC', LayerVersion: 'V1WP', Collection: 'OWI', Faction_1: 'USA', Faction_2: 'RGF' },
				components,
			),
		).toBe('Yehorivka_TC_v1_WP')
	})
})

describe('layerMatchesIngameLayerClassname', () => {
	function layerNamed(name: string) {
		const avail = L.StaticLayerComponents.layerFactionAvailability[name]
		const team1 = avail.find((e) => e.allowedTeams.includes(1))!
		const team2 = avail.find((e) => e.allowedTeams.includes(2) && e.Faction !== team1.Faction)!
		const layer = L.parseRawLayerText(`${name} ${team1.Faction}+${team1.Unit} ${team2.Faction}+${team2.Unit}`)!
		expect(L.isRawLayer(layer)).toBe(false)
		expect(L.toLayer(layer.id).Layer).toBe(name)
		return layer.id
	}

	it('matches a layer to the world of the same name', () => {
		expect(L.layerMatchesIngameLayerClassname(layerNamed('Sumari_Seed_v1'), 'Sumari_Seed_v1')).toBe(true)
		expect(L.layerMatchesIngameLayerClassname(layerNamed('Narva_RAAS_v1'), 'Narva_RAAS_v1')).toBe(true)
	})

	it('matches an FRAAS layer to its RAAS world', () => {
		const fraas = L.StaticLayerComponents.mapLayers.find((c) => c.Gamemode === 'FRAAS')!.Layer
		expect(L.layerMatchesIngameLayerClassname(layerNamed(fraas), fraas.replace('FRAAS', 'RAAS'))).toBe(true)
	})

	it('matches a Jensens Range layer to its world', () => {
		const id = layerNamed('JensensRange_WPMC-TLF')
		expect(L.toLayerText(id)).toBe('JensensRange_WPMC-TLF:WPMC+CombinedArms:TLF+CombinedArms')
		expect(L.layerMatchesIngameLayerClassname(id, 'Jensens_Range_WPMC-TLF')).toBe(true)
		expect(L.layerMatchesIngameLayerClassname(id, 'JensensRange_WPMC-TLF')).toBe(true)
	})

	it('rejects the world of a different layer', () => {
		expect(L.layerMatchesIngameLayerClassname(layerNamed('JensensRange_WPMC-TLF'), 'Jensens_Range_USA-PLA')).toBe(false)
		expect(L.layerMatchesIngameLayerClassname(layerNamed('Narva_RAAS_v1'), 'Narva_AAS_v1')).toBe(false)
		expect(L.layerMatchesIngameLayerClassname(layerNamed('Narva_RAAS_v1'), 'Jensens_Range_WPMC-TLF')).toBe(false)
	})
})
