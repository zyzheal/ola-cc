/**
 * DockerfileParser — extracts build stages, ports, commands, and entrypoints.
 *
 * Nodes: build stages (FROM ... AS), EXPOSE ports, ENTRYPOINT, CMD
 * Edges: stage uses base image, stage exposes port
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

export class DockerfileParser implements FileParser {
  readonly name = 'dockerfile'
  readonly extensions = []  // Matched by file pattern
  readonly filePatterns = ['Dockerfile', 'Dockerfile.dev', 'Dockerfile.prod', 'Dockerfile.test']

  parse(filePath: string, content: string): ParserResult | null {
    const lines = content.split('\n')
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    let currentStage = 'default'
    let currentStageId = `dockerfile:${filePath}:stage:${currentStage}`

    // Create default stage node
    nodes.push({
      id: currentStageId,
      name: currentStage,
      kind: 'stage',
      file: filePath,
      line: 1,
    })

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue

      // Handle line continuations
      let fullLine = trimmed
      while (fullLine.endsWith('\\') && i + 1 < lines.length) {
        i++
        fullLine = fullLine.slice(0, -1).trim() + ' ' + lines[i].trim()
      }

      const match = fullLine.match(/^(\w+)\s+(.*)/)
      if (!match) continue

      const [, instruction, args] = match
      const upperInstruction = instruction.toUpperCase()

      switch (upperInstruction) {
        case 'FROM': {
          // FROM image AS stageName
          const fromMatch = args.match(/^(\S+)(?:\s+[Aa][Ss]\s+(\S+))?/)
          if (fromMatch) {
            const baseImage = fromMatch[1]
            const stageName = fromMatch[2] ?? 'default'
            currentStage = stageName
            currentStageId = `dockerfile:${filePath}:stage:${currentStage}`

            nodes.push({
              id: currentStageId,
              name: currentStage,
              kind: 'stage',
              file: filePath,
              line: i + 1,
              metadata: { baseImage },
            })

            // Edge: stage uses base image
            const baseId = `dockerfile:image:${baseImage}`
            nodes.push({
              id: baseId,
              name: baseImage,
              kind: 'image',
              file: filePath,
              line: i + 1,
            })
            edges.push({
              from: currentStageId,
              to: baseId,
              type: 'uses',
            })
          }
          break
        }

        case 'EXPOSE': {
          // EXPOSE 8080 3000
          const ports = args.split(/\s+/)
          for (const port of ports) {
            const portNum = port.split('/')[0] // Remove protocol suffix
            const portId = `dockerfile:${filePath}:port:${portNum}`
            nodes.push({
              id: portId,
              name: portNum,
              kind: 'port',
              file: filePath,
              line: i + 1,
              metadata: { protocol: port.includes('/') ? port.split('/')[1] : 'tcp' },
            })
            edges.push({
              from: currentStageId,
              to: portId,
              type: 'exposes',
            })
          }
          break
        }

        case 'ENTRYPOINT': {
          const entryId = `dockerfile:${filePath}:entrypoint:${currentStage}`
          nodes.push({
            id: entryId,
            name: 'ENTRYPOINT',
            kind: 'entrypoint',
            file: filePath,
            line: i + 1,
            metadata: { command: args },
          })
          edges.push({
            from: currentStageId,
            to: entryId,
            type: 'defines',
          })
          break
        }

        case 'CMD': {
          const cmdId = `dockerfile:${filePath}:cmd:${currentStage}`
          nodes.push({
            id: cmdId,
            name: 'CMD',
            kind: 'command',
            file: filePath,
            line: i + 1,
            metadata: { command: args },
          })
          edges.push({
            from: currentStageId,
            to: cmdId,
            type: 'defines',
          })
          break
        }

        case 'RUN': {
          // Extract npm/pip/apt install as dependencies
          const installMatch = args.match(/(?:npm|yarn|pnpm)\s+install|pip\s+install|apt-get\s+install/)
          if (installMatch) {
            const runId = `dockerfile:${filePath}:run:${i + 1}`
            nodes.push({
              id: runId,
              name: `install:${currentStage}:${i + 1}`,
              kind: 'install',
              file: filePath,
              line: i + 1,
              metadata: { command: args },
            })
            edges.push({
              from: currentStageId,
              to: runId,
              type: 'executes',
            })
          }
          break
        }
      }
    }

    if (nodes.length <= 1) return null // Only default stage, nothing useful

    return { nodes, edges, file: filePath, parser: this.name }
  }
}
