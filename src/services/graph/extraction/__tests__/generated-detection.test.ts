/**
 * generated-detection tests — verify generated file pattern matching.
 */

import { describe, test, expect } from 'bun:test'
import { isGeneratedFile } from '../generated-detection.js'

describe('isGeneratedFile', () => {
  test('detects Go protobuf files', () => {
    expect(isGeneratedFile('api/service.pb.go')).toBe(true)
    expect(isGeneratedFile('api/service_grpc.pb.go')).toBe(true)
    expect(isGeneratedFile('api/service.pulsar.go')).toBe(true)
  })

  test('detects Go mock files', () => {
    expect(isGeneratedFile('mock_service.go')).toBe(true)
    expect(isGeneratedFile('src/service_mock.go')).toBe(true)
    expect(isGeneratedFile('src/service_mocks.go')).toBe(true)
  })

  test('detects TypeScript/JavaScript codegen', () => {
    expect(isGeneratedFile('src/api.generated.ts')).toBe(true)
    expect(isGeneratedFile('src/api.gen.ts')).toBe(true)
    expect(isGeneratedFile('src/api.pb.ts')).toBe(true)
    expect(isGeneratedFile('src/api_pb.ts')).toBe(true)
    expect(isGeneratedFile('src/api_grpc_pb.ts')).toBe(true)
    expect(isGeneratedFile('src/app.generated.tsx')).toBe(true)
    expect(isGeneratedFile('src/api.gen.tsx')).toBe(true)
    expect(isGeneratedFile('src/api.pb.js')).toBe(true)
  })

  test('detects Python protobuf', () => {
    expect(isGeneratedFile('proto/service_pb2.py')).toBe(true)
    expect(isGeneratedFile('proto/service_pb2_grpc.py')).toBe(true)
    expect(isGeneratedFile('proto/service_pb2.pyi')).toBe(true)
  })

  test('detects C++ protobuf', () => {
    expect(isGeneratedFile('proto/service.pb.cc')).toBe(true)
    expect(isGeneratedFile('proto/service.pb.h')).toBe(true)
  })

  test('detects C# codegen', () => {
    expect(isGeneratedFile('obj/Service.g.cs')).toBe(true)
    expect(isGeneratedFile('ServiceGrpc.cs')).toBe(true)
  })

  test('detects Java codegen', () => {
    expect(isGeneratedFile('ServiceOuterClass.java')).toBe(true)
    expect(isGeneratedFile('ServiceGrpc.java')).toBe(true)
  })

  test('detects Swift protobuf', () => {
    expect(isGeneratedFile('service.pb.swift')).toBe(true)
  })

  test('detects Dart codegen', () => {
    expect(isGeneratedFile('lib/service.g.dart')).toBe(true)
    expect(isGeneratedFile('lib/model.freezed.dart')).toBe(true)
    expect(isGeneratedFile('lib/service.pb.dart')).toBe(true)
    expect(isGeneratedFile('lib/service.pbgrpc.dart')).toBe(true)
    expect(isGeneratedFile('lib/service.chopper.dart')).toBe(true)
  })

  test('detects Rust codegen', () => {
    expect(isGeneratedFile('src/service.generated.rs')).toBe(true)
  })

  test('does not flag hand-written source files', () => {
    expect(isGeneratedFile('src/service.ts')).toBe(false)
    expect(isGeneratedFile('src/service.go')).toBe(false)
    expect(isGeneratedFile('src/service.py')).toBe(false)
    expect(isGeneratedFile('src/service.rs')).toBe(false)
    expect(isGeneratedFile('src/service.java')).toBe(false)
    expect(isGeneratedFile('src/service.cpp')).toBe(false)
    expect(isGeneratedFile('src/service.dart')).toBe(false)
    expect(isGeneratedFile('src/service.swift')).toBe(false)
  })

  test('does not flag partial matches', () => {
    expect(isGeneratedFile('src/pb.go')).toBe(false)
    expect(isGeneratedFile('src/generate.ts')).toBe(false)
    expect(isGeneratedFile('src/mock_service.ts')).toBe(false)
  })
})
