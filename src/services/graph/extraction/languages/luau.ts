/**
 * Luau language extractor configuration.
 * Ported from codegraph with full feature parity.
 *
 * Luau is a gradually-typed superset of Lua. The tree-sitter-luau grammar
 * reuses the same node names as the Lua grammar, so the Luau extractor
 * extends the Lua one and adds type-system pieces.
 */

import type { LanguageExtractor } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'
import { luaExtractor } from './lua.js'

export const luauExtractor: LanguageExtractor = {
  ...luaExtractor,

  // `type X = ...` and `export type X = ...`
  typeAliasTypes: ['type_definition'],

  // Only Luau `export type` is exported
  isExported: (node, source) => source.slice(node.startIndex, node.startIndex + 7) === 'export ',

  // Params + Luau return type
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters')
    if (!params) return undefined
    let sig = getNodeText(params, source)
    const kids = node.namedChildren
    const idx = kids.findIndex((c) => c.startIndex === params.startIndex)
    const ret = idx >= 0 ? kids[idx + 1] : null
    if (ret && ret.type !== 'block') sig += `: ${getNodeText(ret, source)}`
    return sig
  },
}
