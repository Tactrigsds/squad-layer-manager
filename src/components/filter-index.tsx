import * as AR from '@/app-routes.ts'
import { trpcReact } from '@/lib/trpc.client'
import { Link } from 'react-router-dom'

import { buttonVariants } from './ui/button'

export default function FiltersIndex() {
	const filtersData = trpcReact.getFilters.useQuery()
	return (
		<div>
			<div>
				<Link className={buttonVariants()} to={AR.link('/filters/new')}>
					New Filter
				</Link>
			</div>
			<div>
				{filtersData.data?.map((filter) => (
					<div key={filter.id}>
						<h2>{filter.name}</h2>
					</div>
				))}
			</div>
		</div>
	)
}
