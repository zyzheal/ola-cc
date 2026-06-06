/**
 * Generated-file detection for symbol-disambiguation down-ranking.
 *
 * When a query like "Send" matches 17 symbols across protobuf scaffolding,
 * test mocks, and the hand-written implementation, the FTS ranker often
 * surfaces the generated stubs first because their names are identical
 * to the implementation's name.
 *
 * This helper is a pure path-based classifier consulted at disambiguation
 * time (findSymbol / findAllSymbols / codegraph_search formatting), NOT
 * a hard filter — generated nodes are still in the graph and remain
 * reachable; they just rank LAST when there's a real implementation
 * with the same name.
 *
 * Scope: suffix patterns only. Most generated files follow the
 * `<basename>.<tool>.<ext>` convention (`.pb.go`, `_grpc.pb.go`,
 * `.g.dart`, `_pb2.py`).
 */

const GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
  // Go — protobuf / gRPC / pulsar
  /\.pb\.go$/,
  /\.pulsar\.go$/,
  /_grpc\.pb\.go$/,
  // Go — mockgen output
  /_mock\.go$/,
  /_mocks\.go$/,
  /^mock_[^/]+\.go$/,
  // TypeScript / JavaScript — common codegen suffixes
  /\.generated\.[jt]sx?$/,
  /\.gen\.[jt]sx?$/,
  /\.pb\.[jt]s$/,
  /_pb\.[jt]s$/,
  /_grpc_pb\.[jt]s$/,
  // Python — protobuf / gRPC / openapi-codegen
  /_pb2(_grpc)?\.py$/,
  /_pb2\.pyi$/,
  // C++ — protobuf
  /\.pb\.(cc|h)$/,
  // C# — protobuf / gRPC
  /\.g\.cs$/,
  /Grpc\.cs$/,
  // Java — protobuf / gRPC
  /OuterClass\.java$/,
  /Grpc\.java$/,
  // Swift — protobuf
  /\.pb\.swift$/,
  // Dart — build_runner / freezed / json_serializable / chopper
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /\.pb\.dart$/,
  /\.pbgrpc\.dart$/,
  /\.chopper\.dart$/,
  // Rust — common build.rs OUT_DIR outputs
  /\.generated\.rs$/,
]

/**
 * Whether `filePath` looks like a tool-generated source file based on
 * its filename. Path-only — does not read content. The result is a
 * relevance hint for disambiguation, not a hard claim.
 */
export function isGeneratedFile(filePath: string): boolean {
  return GENERATED_PATTERNS.some((p) => p.test(filePath))
}
