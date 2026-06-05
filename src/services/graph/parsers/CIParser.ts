/**
 * CIParser — extracts GitHub Actions workflows, jobs, steps, and actions.
 *
 * Nodes: workflows, jobs, steps, reusable actions
 * Edges: workflow contains job, job contains step, step uses action
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

/** Known GitHub Actions job-level keys (not job names) */
const JOB_KEYS = new Set([
  'runs-on', 'container', 'services', 'env', 'defaults',
  'permissions', 'concurrency', 'outputs', 'strategy',
  'continue-on-error', 'timeout-minutes', 'if', 'needs',
])

export class CIParser implements FileParser {
  readonly name = 'ci'
  readonly extensions = ['.yml', '.yaml']
  readonly filePatterns = []

  parse(filePath: string, content: string): ParserResult | null {
    // Only parse files in .github/workflows
    if (!filePath.includes('.github/workflows')) return null

    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    const lines = content.split('\n')

    // Extract workflow name
    let workflowName = 'unnamed'
    for (const line of lines) {
      const nameMatch = line.match(/^name:\s*(.+)/)
      if (nameMatch) {
        workflowName = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
        break
      }
    }

    const workflowId = `ci:${filePath}:workflow:${workflowName}`
    nodes.push({
      id: workflowId,
      name: workflowName,
      kind: 'workflow',
      file: filePath,
      line: 1,
      metadata: { fileName: filePath.split('/').pop() },
    })

    let currentJob: string | null = null
    let currentJobId: string | null = null
    let inJobs = false
    let inSteps = false
    let stepIndex = 0
    let jobIndent = -1

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      if (!trimmed || trimmed.startsWith('#')) continue

      const indent = line.search(/\S/)

      // Detect 'jobs:' section
      if (trimmed === 'jobs:' && indent <= 2) {
        inJobs = true
        continue
      }

      if (!inJobs) continue

      // If we see a top-level key at indent 0, we left jobs section
      if (indent === 0 && trimmed.endsWith(':') && !trimmed.startsWith('-')) {
        inJobs = false
        continue
      }

      // Detect 'steps:' within a job (must check before jobMatch)
      if (trimmed === 'steps:' && currentJob && indent > jobIndent) {
        inSteps = true
        continue
      }

      // Job definition: indented key ending with ':' at job level (indent 2-4)
      const jobMatch = line.match(/^(\s{2,4})(\w[\w-]*):\s*$/)
      if (jobMatch) {
        const jobName = jobMatch[2]
        // Filter out known GH Actions keys
        if (!JOB_KEYS.has(jobName)) {
          currentJob = jobName
          currentJobId = `ci:${filePath}:job:${currentJob}`
          jobIndent = jobMatch[1].length
          stepIndex = 0
          inSteps = false

          nodes.push({
            id: currentJobId,
            name: currentJob,
            kind: 'job',
            file: filePath,
            line: i + 1,
          })
          edges.push({
            from: workflowId,
            to: currentJobId,
            type: 'contains',
          })
        }
        continue
      }

      // Process steps
      if (inSteps && currentJobId && indent > jobIndent) {
        // Step with 'uses:' — reusable action
        const usesMatch = trimmed.match(/uses:\s*(.+)/)
        if (usesMatch) {
          const action = usesMatch[1].trim().replace(/^['"]|['"]$/g, '')
          const stepId = `ci:${filePath}:step:${currentJob}:${stepIndex}`

          nodes.push({
            id: stepId,
            name: action.split('@')[0],
            kind: 'step',
            file: filePath,
            line: i + 1,
            metadata: { action, version: action.includes('@') ? action.split('@')[1] : undefined },
          })
          edges.push({
            from: currentJobId,
            to: stepId,
            type: 'contains',
          })

          const actionId = `ci:action:${action.split('@')[0]}`
          nodes.push({
            id: actionId,
            name: action.split('@')[0],
            kind: 'action',
            file: filePath,
            line: i + 1,
          })
          edges.push({
            from: stepId,
            to: actionId,
            type: 'uses',
          })

          stepIndex++
          continue
        }

        // Step with 'run:' — shell command
        const runMatch = trimmed.match(/run:\s*(.+)/)
        if (runMatch) {
          const stepId = `ci:${filePath}:step:${currentJob}:${stepIndex}`
          const stepName = runMatch[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 60)

          nodes.push({
            id: stepId,
            name: stepName || `run:${stepIndex}`,
            kind: 'step',
            file: filePath,
            line: i + 1,
            metadata: { command: runMatch[1].trim() },
          })
          edges.push({
            from: currentJobId,
            to: stepId,
            type: 'contains',
          })
          stepIndex++
          continue
        }

        // Step with 'name:' — update last step's name
        const nameMatch = trimmed.match(/name:\s*(.+)/)
        if (nameMatch && stepIndex > 0) {
          const lastStepId = `ci:${filePath}:step:${currentJob}:${stepIndex - 1}`
          const existingNode = nodes.find(n => n.id === lastStepId)
          if (existingNode) {
            existingNode.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
          }
          continue
        }

        // If indent is at/below job level, we left steps
        if (indent <= jobIndent) {
          inSteps = false
        }
      }

      // Job-level 'needs:' — job dependency
      const needsMatch = trimmed.match(/needs:\s*(.+)/)
      if (needsMatch && currentJobId && !inSteps) {
        const deps = needsMatch[1].replace(/[\[\]]/g, '').split(/\s*,\s*/)
        for (const dep of deps) {
          const depName = dep.trim().replace(/^['"]|['"]$/g, '')
          if (depName) {
            const depId = `ci:${filePath}:job:${depName}`
            edges.push({
              from: currentJobId,
              to: depId,
              type: 'depends',
            })
          }
        }
      }
    }

    if (nodes.length <= 1) return null

    return { nodes, edges, file: filePath, parser: this.name }
  }
}
