/***
 * Disposable vibecoded script to produce diffs from zero's scorings
 */

import * as Paths from '$root/paths.ts'
import * as Arr from '@/lib/array'
import * as LC from '@/models/layer-columns'
import { parse } from 'csv-parse'
import { stringify } from 'csv-stringify'
import fs from 'node:fs'
import path from 'node:path'

function findPairedColumns(columns: string[]): Array<[string, string, string]> {
	const pairs: Array<[string, string, string]> = []

	// Find columns ending with _1
	const columns1 = columns.filter(col => col.endsWith('_1') && col !== 'SubFac_1')
	const columns2 = columns.filter(col => col.endsWith('_2') && col !== 'SubFac_2')

	for (const col1 of columns1) {
		// Get the base name by removing _1
		const baseName = col1.slice(0, -2)
		const col2 = baseName + '_2'

		// Check if corresponding _2 column exists
		if (columns2.includes(col2) && !Arr.includes(LC.COLUMN_KEYS, col2)) {
			pairs.push([col1, col2, baseName + '_Diff'])
		}
	}

	return pairs
}

// Function to calculate difference between two numeric values
function calculateDiff(val1: string, val2: string): string | null {
	const num1 = parseFloat(val1)
	const num2 = parseFloat(val2)
	if (isNaN(num1) || isNaN(num2)) {
		return null
	}
	return (num1 - num2).toString()
}

async function processCSV() {
	const inputPath = process.argv[2] ?? path.join(Paths.DATA, 'layers_raw.csv')
	const outputPath = process.argv[3] ?? path.join(Paths.DATA, 'layers.csv')
	console.log(`Input path: ${inputPath}`)
	console.log(`Output path: ${outputPath}`)

	let headers: string[] = []
	let pairedColumns: Array<[string, string, string]> = []
	let diffColumns: string[] = []

	// First pass: identify numeric columns
	await new Promise<void>((resolve, reject) => {
		let rowCount = 0

		fs.createReadStream(inputPath, 'utf8')
			.pipe(parse({
				columns: true,
				skip_empty_lines: true,
			}))
			.on('data', (row) => {
				rowCount++

				if (rowCount === 1) {
					// First row - get headers
					headers = Object.keys(row)

					// Find paired columns (_1 and _2)
					pairedColumns = findPairedColumns(headers)
					diffColumns = pairedColumns.map(([col1, col2, diffCol]) => diffCol)

					console.log(`Found ${pairedColumns.length} paired columns:`)
					pairedColumns.forEach(([col1, col2, diffCol]) => {
						console.log(`  ${col1} & ${col2} -> ${diffCol}`)
					})
				}

				// Only process first row to identify columns
				if (rowCount >= 1) {
					resolve()
				}
			})
			.on('error', reject)
	})

	// Second pass: process data and write output
	const outputStream = fs.createWriteStream(outputPath)
	const stringifier = stringify({
		header: false,
		columns: [...headers, ...diffColumns],
	})

	stringifier.pipe(outputStream)

	// Write header row
	const headerRow = [...headers, ...diffColumns]
	stringifier.write(headerRow)

	// Process data rows
	await new Promise<void>((resolve, reject) => {
		fs.createReadStream(inputPath, 'utf8')
			.pipe(parse({
				columns: true,
				skip_empty_lines: true,
			}))
			.on('data', (row) => {
				// Calculate diffs for paired columns
				const processedRow = { ...row }

				for (const [col1, col2, diffCol] of pairedColumns) {
					processedRow[diffCol] = calculateDiff(row[col1], row[col2])
					if (processedRow[diffCol] === null) {
						return
					}
				}

				// Write the row with diff columns
				stringifier.write(processedRow)
			})
			.on('end', () => {
				stringifier.end()
				resolve()
			})
			.on('error', reject)
	})

	await new Promise<void>((resolve, reject) => {
		outputStream.on('finish', resolve)
		outputStream.on('error', reject)
	})

	console.log(` Processing complete. Output written to ${outputPath}`)
}

// Run the processing
processCSV().catch(console.error)
