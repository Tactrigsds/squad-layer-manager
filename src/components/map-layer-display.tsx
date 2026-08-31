import * as Atoms from './feed/atoms'

export default function MapLayerDisplay(props: {
	layer: string
	extraLayerStyles?: Record<string, string | undefined>
	className?: string
}) {
	return <Atoms.MapLayerDisplay layer={props.layer} extraStyles={props.extraLayerStyles} className={props.className} />
}
