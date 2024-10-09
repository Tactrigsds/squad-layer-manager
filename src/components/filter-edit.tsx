import useAppParams from '@/hooks/use-app-params'
import { useParams } from 'react-router-dom'

import { FilterCard } from './filter-card'
import LayerExplorer from './layer-explorer'
import LayerTable from './layer-table'

export default function FilterEdit() {
	const { id: filterId } = useAppParams()
	const form = useForm({
		defaultValues: {
			name: '',
			description: '',
			filter: '',
			layer: '',
		},
	})

	return (
		<div className="container mx-auto py-10">
			<div>
				<input />
			</div>
			<FilterCard />
			<LayerTable />
		</div>
	)
}
