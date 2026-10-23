// The page's Monaco code editors, for the content script's Beautify button.
//
// viaSocket bundles Monaco as ES modules and exposes neither it nor its editors on window, so an editor instance is
// found through React: @monaco-editor/react keeps it in a ref of its <Editor> component, a few fibers above the
// element Monaco was created in. A candidate only counts when its own DOM node is that `.monaco-editor` element, so
// a different editor can never be edited by mistake.
//
// Formatting goes through the editor's own edit API, between undo stops, which the app sees exactly like typing: its
// onChange runs (that is what marks a step unsaved), and the editor is focused first so the app's on-blur commit of the
// code into the step's draft also runs once the user moves on. A single Cmd/Ctrl+Z undoes the whole format.

import { isObj } from '../shared/classify'
import { EDITOR_ID_ATTR, type EditorAction, type EditorActionResult } from '../shared/messages'
import { codeLanguage, formatCode } from './format-code'

interface Position {
  lineNumber: number
  column: number
}

interface TextModel {
  getValue(): string
  getLanguageId(): string
  getPositionAt(offset: number): Position
}

interface EditRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

interface CodeEditor {
  getDomNode(): HTMLElement | null
  getModel(): TextModel | null
  getRawOptions(): { readOnly?: unknown; domReadOnly?: unknown }
  focus(): void
  pushUndoStop(): boolean
  executeEdits(source: string, edits: Array<{ range: EditRange; text: string }>): boolean
}

const EDIT_SOURCE = 'vs-assistant-beautify'
/** Ids the content script generates (hex); anything else could not be used in a selector safely */
const EDITOR_ID_RE = /^[a-f0-9]{16,32}$/
/** React fiber tags of components that keep hooks: function, forwardRef, memo, simple memo */
const HOOK_FIBER_TAGS = new Set([0, 11, 14, 15])
/** @monaco-editor/react's Editor sits 2-3 fibers above Monaco's container element */
const MAX_FIBER_HOPS = 10
const MAX_HOOKS = 64

const editors = new WeakMap<Element, CodeEditor>()

/** Reads a plain data property only, so a getter on some component's state is never run */
function own(obj: Record<string, unknown>, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key)
  return d && 'value' in d ? d.value : undefined
}

function isEditorOf(v: unknown, el: Element): v is CodeEditor {
  if (!isObj(v)) return false
  for (const fn of ['getDomNode', 'getModel', 'getRawOptions', 'focus', 'pushUndoStop', 'executeEdits']) {
    if (typeof v[fn] !== 'function') return false
  }
  return (v as unknown as CodeEditor).getDomNode() === el
}

function findEditor(el: Element): CodeEditor | null {
  const known = editors.get(el)
  if (known) return known
  const container = el.parentElement
  if (!container) return null
  const key = Object.keys(container).find((k) => k.startsWith('__reactFiber$'))
  let fiber: unknown = key ? own(container as unknown as Record<string, unknown>, key) : undefined
  for (let hops = 0; isObj(fiber) && hops < MAX_FIBER_HOPS; hops++) {
    if (HOOK_FIBER_TAGS.has(own(fiber, 'tag') as number)) {
      // A function component's hooks are a linked list; a useRef hook's state is { current }.
      let hook = own(fiber, 'memoizedState')
      for (let n = 0; isObj(hook) && n < MAX_HOOKS; n++) {
        const state = own(hook, 'memoizedState')
        const current = isObj(state) ? own(state, 'current') : undefined
        if (isEditorOf(current, el)) {
          editors.set(el, current)
          return current
        }
        hook = own(hook, 'next')
      }
    }
    fiber = own(fiber, 'return')
  }
  return null
}

/** Never throws: runs inside the page's message event. */
export function editorAction(editorId: string, action: EditorAction): EditorActionResult {
  try {
    if (!EDITOR_ID_RE.test(editorId)) return 'missing'
    const el = document.querySelector(`.monaco-editor[${EDITOR_ID_ATTR}="${editorId}"]`)
    const editor = el ? findEditor(el) : null
    if (!editor?.getModel()) return 'missing'
    const options = editor.getRawOptions()
    if (options.readOnly === true || options.domReadOnly === true) return 'read-only'
    const language = codeLanguage(editor.getModel()?.getLanguageId() ?? '')
    if (!language) return 'unsupported'
    if (action === 'check') return 'ready'

    // Focus first, as a click into the editor would: the app's focus handlers run before the text is read, and its
    // on-blur commit then saves the formatted code like typed code.
    editor.focus()
    const model = editor.getModel()
    if (!model) return 'missing'
    const result = formatCode(model.getValue(), language)
    if (result.kind !== 'edits') return result.kind
    if (!result.edits.length) return 'unchanged'
    const edits = result.edits.map((e) => {
      const start = model.getPositionAt(e.start)
      const end = model.getPositionAt(e.end)
      return {
        range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
        text: e.text,
      }
    })
    editor.pushUndoStop()
    const applied = editor.executeEdits(EDIT_SOURCE, edits)
    editor.pushUndoStop()
    return applied ? 'formatted' : 'read-only'
  } catch {
    return 'failed'
  }
}
