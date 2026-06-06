/**
 * Tree-sitter Shared Helpers
 *
 * Re-exports from helpers.ts for backward compatibility.
 * The canonical helper functions live in helpers.ts.
 */

export {
  generate_node_id,
  get_node_text,
  get_child_by_field,
  get_preceding_docstring,
  // camelCase aliases
  generateNodeId,
  getNodeText,
  getChildByField,
  getPrecedingDocstring,
} from './helpers.js'
