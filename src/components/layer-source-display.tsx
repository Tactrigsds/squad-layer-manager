import { Badge } from '@/components/ui/badge.tsx'
import * as Text from '@/lib/text'
import { assertNever } from '@/lib/type-guards'
import * as LL from '@/models/layer-list.models'
import * as PartsSys from '@/systems.client/parts.ts'

export default function LayerSourceDisplay(props: { source: LL.LayerSource }) {
	switch (props.source.type) {
		case 'gameserver':
			return <Badge variant="outline">Game Server</Badge>
		case 'unknown':
		case 'generated':
			return <Badge variant="outline">{Text.capitalize(props.source.type)}</Badge>
			break
		case 'manual': {
			return <Badge variant="outline">{PartsSys.findUser(props.source.userId)?.username ?? 'Unknown'}</Badge>
			break
		}
		default:
			assertNever(props.source)
	}
}
