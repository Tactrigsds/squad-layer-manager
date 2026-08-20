import { describe, expect, it } from 'vitest'

import * as LC_Msgs from '@/messages/layer-columns.messages'

import * as L from './layer'
import * as LC from './layer-columns'

describe('vehicle classes', () => {
	// the classification reads the map icon, so a vehicle whose icon names a role rather than a chassis
	// (map_antiair, T_map_mgs) is the case that regresses. The chassis of each of these is unambiguous.
	const expected: Record<string, string> = {
		'BMP-2': 'IFV_TRACKED',
		FV510: 'IFV_TRACKED',
		M2A3: 'IFV_TRACKED',
		ASLAV: 'IFV_WHEELED',
		'LAV 6': 'IFV_WHEELED',
		ZBL08: 'IFV_WHEELED',
		'M113A3 M2': 'APC_TRACKED',
		'MT-LB PKT': 'APC_TRACKED',
		'AAVP-7A1': 'APC_TRACKED',
		'BTR-80': 'APC_WHEELED',
		'LAV-25': 'APC_WHEELED',
		'M1126 CROWS M2': 'APC_WHEELED',
		'MT-LB Logistics': 'LOGI_TRACKED',
		'M113A3 Logistics': 'LOGI_TRACKED',
		'M939 Logistics': 'LOGI_WHEELED',
		'Logistics Pickup Truck': 'LOGI_WHEELED',
		'RHIB Logistics': 'LOGI_BOAT',
		'RHIB M2': 'BOAT',
		'RHIB Transport': 'BOAT',
		'Quad Bike': 'ULTV',
		M1A1: 'MBT',
	}

	for (const [vehicle, type] of Object.entries(expected)) {
		it(`files ${vehicle} under ${type}`, () => {
			expect(LC.vehicleTypeForVehicle(vehicle)).toBe(type)
		})
	}

	it('files every boat under a boat class, and none under the runabout classes', () => {
		const boats = L.StaticLayerComponents.vehicles!.filter((vehicle) => vehicle.startsWith('RHIB'))
		expect(boats.length).toBeGreaterThan(10)
		expect(boats.filter((vehicle) => !LC.vehicleTypeForVehicle(vehicle)?.includes('BOAT'))).toEqual([])
	})

	it('labels every class the tables use', () => {
		const unlabelled = L.StaticLayerComponents.vehicleTypes!.filter((type) => !LC_Msgs.vehicleTypeLabels[type])
		expect(unlabelled).toEqual([])
	})

	// what the layer details panel rests on: it has a unit's rows and the artifact's per-record vehicle set, and
	// recovers the row's vehicle from its name. A record holding two canonical vehicles under one name, or one
	// whose rows the tables never clustered, would show that row the source's class instead.
	it('resolves every vehicle row of every unit record', () => {
		const unresolved: string[] = []
		for (const unit of Object.values(L.StaticFactionunitConfigs)) {
			const types = LC.vehicleTypesForUnitRecord(unit)
			unit.vehicles.forEach((vehicle, i) => {
				if (!types[i]) unresolved.push(`${unit.unitObjectName}: ${vehicle.name || vehicle.rowName}`)
			})
		}
		expect(unresolved).toEqual([])
	})
})
