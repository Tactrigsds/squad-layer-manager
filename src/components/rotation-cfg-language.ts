// Syntax highlighting for the plain-text rotation format, a Squad layer rotation .cfg file: `#` lines are comments,
// including SLM's `# VOTE:` and `# TAGS:` lines (see src/models/rotation-format.models.ts). Only the lazily-loaded
// source editor may import this, since it pulls in CodeMirror.
import { StreamLanguage } from '@codemirror/language'

export const rotationCfg = StreamLanguage.define<null>({
	name: 'squad-rotation-cfg',
	startState: () => null,
	token(stream) {
		if (stream.sol() && stream.match(/^\s*#/)) {
			stream.skipToEnd()
			return 'comment'
		}
		stream.skipToEnd()
		return null
	},
})
