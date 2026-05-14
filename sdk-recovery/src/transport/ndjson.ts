export interface NdjsonParseResult {
  data?: Record<string, unknown>;
  parse_error?: string;
  raw?: string;
}

const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB safety limit

export class NdjsonParser {
  private buffer = '';

  push(chunk: string): NdjsonParseResult[] {
    this.buffer += chunk;

    // Safety: if buffer exceeds 1MB without a newline, truncate to prevent OOM
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      const error = `NDJSON buffer exceeded ${MAX_BUFFER_SIZE} bytes`;
      this.buffer = '';
      return [{ parse_error: error }];
    }

    const results: NdjsonParseResult[] = [];
    const lines = this.buffer.split('\n');

    // Keep last element in buffer (may be partial line)
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      try {
        const parsed = JSON.parse(trimmed);
        results.push({ data: parsed });
      } catch {
        results.push({
          parse_error: `Failed to parse NDJSON line: ${trimmed.slice(0, 100)}`,
          raw: trimmed,
        });
      }
    }

    return results;
  }

  reset(): void {
    this.buffer = '';
  }
}
