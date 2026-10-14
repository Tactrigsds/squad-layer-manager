// The extensions that give SLM's CodeMirror editors their key bindings, apart from the rest of the setup in
// ./codemirror.ts, so keybinds.models.test.ts can read the keymap the editors run without loading the schema tooling.
import { indentWithTab } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'

export { basicSetup }

// basicSetup leaves Tab alone so keyboard users can leave the editor, but indentation is structure in YAML, so Tab has
// to indent there. It inserts the indentUnit (two spaces) rather than a tab character, which YAML rejects as
// indentation. Ctrl-m (Shift-Alt-m on mac) still frees Tab to move focus.
export const yamlIndentKeymap = keymap.of([indentWithTab])
