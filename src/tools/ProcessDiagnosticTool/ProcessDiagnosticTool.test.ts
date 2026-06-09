import { describe, it, expect } from 'bun:test'
import { NotFoundError, AmbiguousError, TimeoutError, DiagnosticError } from '../../services/process-diagnostic/types'

// C1: Error types should be preserved in tool output
describe('ProcessDiagnosticTool - C1: error type preservation', () => {
  it('should preserve error code from DiagnosticError subclasses', () => {
    const notFound = new NotFoundError('No process found')
    expect(notFound.code).toBe('NOT_FOUND')
    expect(notFound.name).toBe('NotFoundError')

    const ambiguous = new AmbiguousError('Multiple matches', [100, 200])
    expect(ambiguous.code).toBe('AMBIGUOUS')
    expect(ambiguous.pids).toEqual([100, 200])

    const timeout = new TimeoutError('Timed out')
    expect(timeout.code).toBe('TIMEOUT')
  })

  it('should be able to distinguish error types via code', () => {
    const errors = [
      new NotFoundError('not found'),
      new AmbiguousError('ambiguous', [1, 2]),
      new TimeoutError('timeout'),
    ]
    const codes = errors.map(e => e instanceof DiagnosticError ? e.code : 'UNKNOWN')
    expect(codes).toEqual(['NOT_FOUND', 'AMBIGUOUS', 'TIMEOUT'])
  })
})
