import { FilterCard } from './filter-card'
import LayerTable from './layer-table'

export default function LayerExplorer() {
	return (
		<div className="container mx-auto py-10">
			<FilterCard />
			<LayerTable />
		</div>
	)
}
