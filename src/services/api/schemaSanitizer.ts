/**
 * JSON Schema sanitization for API compatibility.
 *
 * Some API proxies (DashScope, LiteLLM, etc.) and non-Anthropic models
 * reject JSON Schema keywords that Anthropic's API supports. This module
 * provides a shared sanitization function used by both the OpenAI shim
 * and the Anthropic SDK tool schema path.
 *
 * Removed keywords:
 * - $ref, $defs, $schema, definitions (reference/definition keywords)
 * - anyOf, oneOf, allOf (polymorphism)
 * - const (constant values — converted to enum with single value)
 * - if/then/else (conditional schemas)
 * - contains, propertyNames, patternProperties, additionalItems (advanced constraints)
 */

/**
 * Sanitize a nested JSON Schema (properties, array items, additionalProperties).
 * Does NOT force type: 'object' — that is only for top-level tool schemas.
 */
export function sanitizeNestedSchema(
  schema: unknown,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return schema as Record<string, unknown>
  }

  const result = { ...(schema as Record<string, unknown>) }

  // Convert 'integer' to 'number' for OpenAI compatibility
  if (result.type === 'integer') {
    result.type = 'number'
  }

  // Normalize type: if it's an array, take the first element
  if (Array.isArray(result.type)) {
    result.type = result.type[0]
    if (result.type === 'integer') result.type = 'number'
    if (result.type === 'null') result.type = 'string'
  }

  // Remove polymorphism
  delete result.anyOf
  delete result.oneOf
  delete result.allOf

  // Remove unsupported JSON Schema keywords
  delete result.$ref
  delete result.$defs
  delete result.$schema
  delete result.definitions
  // Convert const to enum (preserves the constraint in a widely-supported form)
  if (result.const !== undefined) {
    result.enum = [result.const]
    delete result.const
  }
  delete result.if
  delete result.then
  delete result.else
  delete result.contains
  delete result.propertyNames
  delete result.patternProperties
  delete result.additionalItems

  // Handle malformed required field (non-array → delete)
  if (result.required !== undefined && !Array.isArray(result.required)) {
    delete result.required
  }

  // Recurse into object properties
  if (result.properties && typeof result.properties === 'object') {
    const properties = result.properties as Record<string, unknown>
    for (const [key, value] of Object.entries(properties)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        properties[key] = sanitizeNestedSchema(value)
      }
    }
    // Filter required fields that reference removed properties
    if (Array.isArray(result.required)) {
      result.required = (result.required as string[]).filter(
        k => typeof k === 'string' && k in properties,
      )
    }
  }

  // Recurse into array items
  if (result.type === 'array' && result.items && typeof result.items === 'object') {
    result.items = sanitizeNestedSchema(result.items)
  }

  // Recurse into additionalProperties
  if (result.additionalProperties && typeof result.additionalProperties === 'object') {
    result.additionalProperties = sanitizeNestedSchema(result.additionalProperties)
  }

  return result
}

/**
 * Sanitize a top-level tool JSON Schema for API compatibility.
 * OpenAI-compatible providers require tool schemas to have type: 'object'.
 */
export function sanitizeSchemaForAPI(
  schema: unknown,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }

  const obj = schema as Record<string, unknown>
  const result = { ...obj }

  // Ensure type is a single string (top-level tool schemas must be objects)
  if (Array.isArray(result.type)) {
    result.type = result.type[0]
  }
  result.type = 'object'

  // Ensure properties exists and is an object
  if (!result.properties || typeof result.properties !== 'object') {
    result.properties = {}
  }

  // Remove anyOf/oneOf/allOf
  delete result.anyOf
  delete result.oneOf
  delete result.allOf

  // Remove unsupported JSON Schema keywords
  delete result.$ref
  delete result.$defs
  delete result.$schema
  delete result.definitions
  // Convert const to enum
  if (result.const !== undefined) {
    result.enum = [result.const]
    delete result.const
  }
  delete result.if
  delete result.then
  delete result.else
  delete result.contains
  delete result.propertyNames
  delete result.patternProperties
  delete result.additionalItems

  // Handle malformed required field
  if (result.required !== undefined && !Array.isArray(result.required)) {
    delete result.required
  }

  const properties = result.properties as Record<string, unknown>
  const required = result.required

  if (Array.isArray(required)) {
    // Ensure all required fields have properties
    for (const key of required) {
      if (typeof key === 'string' && !(key in properties)) {
        properties[key] = { type: 'string' }
      }
    }
    // Remove non-string entries and entries not in properties
    result.required = required.filter(
      (k) => typeof k === 'string' && k in properties,
    )
  }

  // Recursively sanitize nested properties
  for (const [key, value] of Object.entries(properties)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      properties[key] = sanitizeNestedSchema(value)
    }
  }

  // Sanitize additionalProperties if present
  if (result.additionalProperties && typeof result.additionalProperties === 'object') {
    result.additionalProperties = sanitizeNestedSchema(result.additionalProperties)
  }

  return result
}
