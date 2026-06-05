/**
 * Parser barrel export — registers all built-in parsers.
 */

export type { FileParser, ParsedNode, ParsedEdge, ParserResult } from './types.js'
export { ParserRegistry } from './ParserRegistry.js'
export { DockerfileParser } from './DockerfileParser.js'
export { CIParser } from './CIParser.js'
export { YAMLParser } from './YAMLParser.js'
export { JSONParser } from './JSONParser.js'
export { TerraformParser } from './TerraformParser.js'
export { OpenAPIParser } from './OpenAPIParser.js'
export { GraphQLParser } from './GraphQLParser.js'
export { ProtobufParser } from './ProtobufParser.js'
export { SQLParser } from './SQLParser.js'

import { ParserRegistry } from './ParserRegistry.js'
import { DockerfileParser } from './DockerfileParser.js'
import { CIParser } from './CIParser.js'
import { YAMLParser } from './YAMLParser.js'
import { JSONParser } from './JSONParser.js'
import { TerraformParser } from './TerraformParser.js'
import { OpenAPIParser } from './OpenAPIParser.js'
import { GraphQLParser } from './GraphQLParser.js'
import { ProtobufParser } from './ProtobufParser.js'
import { SQLParser } from './SQLParser.js'

/**
 * Create a registry with all built-in parsers registered.
 */
export function createDefaultRegistry(): ParserRegistry {
  const registry = new ParserRegistry()
  registry.register(new DockerfileParser())
  registry.register(new CIParser())
  registry.register(new YAMLParser())
  registry.register(new JSONParser())
  registry.register(new TerraformParser())
  registry.register(new OpenAPIParser())
  registry.register(new GraphQLParser())
  registry.register(new ProtobufParser())
  registry.register(new SQLParser())
  return registry
}
