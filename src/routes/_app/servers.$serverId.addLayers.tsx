import { frameManager } from '@/frames/frame-manager'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import * as FRM from '@/lib/frame'
import * as LQY from '@/models/layer-queries.models'
import { createFileRoute } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { z } from 'zod'

const AddLayersSearch = z.object({
	cursor: z.any() as z.ZodType<LQY.Cursor>,
})

export const Route = createFileRoute('/_app/servers/$serverId/addLayers')({
	component: RouteComponent,
	validateSearch: zodValidator(AddLayersSearch),
	loaderDeps: ({ search }) => ({ cursor: search.cursor }),
	loader: ({ deps }) => {
		const input = SelectLayersFrame.createInput({ cursor: deps.cursor })
		const frameKey = frameManager.ensureSetup(SelectLayersFrame.frame, input)
		return {
			frames: FRM.toProp(frameKey),
		}
	},
})

function RouteComponent() {
	return <div>Hello "/_app/servers/$serverId/addLayers"!</div>
}
