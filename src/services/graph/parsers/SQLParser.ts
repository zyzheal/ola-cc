/**
 * SQLParser — extracts tables, columns, indexes, and foreign keys from .sql files.
 *
 * Nodes: tables, columns, indexes, foreign keys
 * Edges: table has column, foreign key references table
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

export class SQLParser implements FileParser {
  readonly name = 'sql'
  readonly extensions = ['.sql']
  readonly filePatterns = []

  parse(filePath: string, content: string): ParserResult | null {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    const lines = content.split('\n')

    // Normalize: collapse multi-line statements
    const normalized = content.replace(/\r\n/g, '\n')
    const statements = normalized.split(/;\s*\n/)

    for (const stmt of statements) {
      const trimmed = stmt.trim()
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*')) continue

      // CREATE TABLE
      const createMatch = trimmed.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*)\)/i)
      if (createMatch) {
        const [, tableName, body] = createMatch
        const tableId = `sql:${filePath}:table:${tableName}`

        // Find line number
        const stmtIndex = normalized.indexOf(trimmed)
        const lineNum = normalized.slice(0, stmtIndex).split('\n').length

        nodes.push({
          id: tableId,
          name: tableName,
          kind: 'table',
          file: filePath,
          line: lineNum,
        })

        // Parse columns
        const colLines = body.split(',').map(l => l.trim()).filter(Boolean)
        for (const colLine of colLines) {
          // Skip constraints
          if (/^\s*(PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT|FOREIGN\s+KEY|INDEX)/i.test(colLine)) {
            // Extract foreign key references
            const fkMatch = colLine.match(/FOREIGN\s+KEY\s*\(\s*[`"']?(\w+)[`"']?\s*\)\s*REFERENCES\s+[`"']?(\w+)[`"']?\s*\(\s*[`"']?(\w+)[`"']?\s*\)/i)
            if (fkMatch) {
              const [, fkCol, refTable, refCol] = fkMatch
              edges.push({
                from: tableId,
                to: `sql:${filePath}:table:${refTable}`,
                type: 'references',
                metadata: { foreignKey: fkCol, references: refCol },
              })
            }
            continue
          }

          // Column definition: column_name TYPE ...
          const colMatch = colLine.match(/^[`"']?(\w+)[`"']?\s+(\w+)/)
          if (colMatch) {
            const [, colName, colType] = colMatch
            const colId = `sql:${filePath}:column:${tableName}.${colName}`
            nodes.push({
              id: colId,
              name: `${tableName}.${colName}`,
              kind: 'column',
              file: filePath,
              line: lineNum,
              metadata: { type: colType, table: tableName },
            })
            edges.push({
              from: tableId,
              to: colId,
              type: 'has_column',
            })

            // Inline REFERENCES
            const inlineRef = colLine.match(/REFERENCES\s+[`"']?(\w+)[`"']?\s*\(\s*[`"']?(\w+)[`"']?\s*\)/i)
            if (inlineRef) {
              edges.push({
                from: tableId,
                to: `sql:${filePath}:table:${inlineRef[1]}`,
                type: 'references',
                metadata: { foreignKey: colName, references: inlineRef[2] },
              })
            }
          }
        }
        continue
      }

      // CREATE INDEX
      const indexMatch = trimmed.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s+ON\s+[`"']?(\w+)[`"']?\s*\(([^)]+)\)/i)
      if (indexMatch) {
        const [, indexName, tableName, columns] = indexMatch
        const indexId = `sql:${filePath}:index:${indexName}`
        const stmtIndex = normalized.indexOf(trimmed)
        const lineNum = normalized.slice(0, stmtIndex).split('\n').length

        nodes.push({
          id: indexId,
          name: indexName,
          kind: 'index',
          file: filePath,
          line: lineNum,
          metadata: { table: tableName, columns: columns.split(',').map(c => c.trim()) },
        })
        edges.push({
          from: indexId,
          to: `sql:${filePath}:table:${tableName}`,
          type: 'indexes',
        })
        continue
      }

      // ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY
      const alterFkMatch = trimmed.match(/ALTER\s+TABLE\s+[`"']?(\w+)[`"']?\s+[\s\S]*FOREIGN\s+KEY\s*\(\s*[`"']?(\w+)[`"']?\s*\)\s*REFERENCES\s+[`"']?(\w+)[`"']?\s*\(\s*[`"']?(\w+)[`"']?\s*\)/i)
      if (alterFkMatch) {
        const [, tableName, fkCol, refTable, refCol] = alterFkMatch
        edges.push({
          from: `sql:${filePath}:table:${tableName}`,
          to: `sql:${filePath}:table:${refTable}`,
          type: 'references',
          metadata: { foreignKey: fkCol, references: refCol },
        })
      }
    }

    if (nodes.length === 0) return null
    return { nodes, edges, file: filePath, parser: this.name }
  }
}
