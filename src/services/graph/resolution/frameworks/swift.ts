/**
 * Swift Framework Resolver
 *
 * Handles SwiftUI, UIKit, and Vapor (server-side Swift) patterns.
 * Migrated from codegraph/src/resolution/frameworks/swift.ts.
 *
 * Source mapping:
 *  codegraph Node      → NodeMetadata (from GraphStore)
 *  n.filePath          → n.file
 *  n.startLine         → n.line
 *  n.endLine           → n.end_line
 *  n.qualifiedName     → n.qualified_name
 *  n.updatedAt         → n.updated_at
 *  n.startColumn       → n.start_column
 *  n.endColumn         → n.end_column
 */

import type { NodeMetadata } from '../../GraphStore.js'
import type {
  FrameworkResolver,
  FrameworkExtractionResult,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types.js'
import { stripCommentsForRegex } from '../strip-comments.js'

export const swiftUIResolver: FrameworkResolver = {
  name: 'swiftui',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles()
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file)
        if (content && content.includes('import SwiftUI')) {
          return true
        }
      }
    }

    for (const file of allFiles) {
      if (file.endsWith('.xcodeproj') || file.endsWith('.xcworkspace')) {
        return true
      }
    }

    return false
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: View references (SwiftUI views are PascalCase ending in View)
    if (ref.referenceName.endsWith('View') && /^[A-Z]/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, VIEW_KINDS, VIEW_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 2: ViewModel/ObservableObject references
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Store') || ref.referenceName.endsWith('Manager')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, VIEWMODEL_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 3: Model references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, MODEL_KINDS, MODEL_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.7, resolvedBy: 'framework' }
      }
    }

    return null
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] }
    const nodes: NodeMetadata[] = []
    const now = Date.now()
    const safe = stripCommentsForRegex(content, 'swift')

    // Extract SwiftUI View structs: struct ContentView: View { ... }
    const viewPattern = /struct\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*View/g
    let match: RegExpExecArray | null
    while ((match = viewPattern.exec(safe)) !== null) {
      const [, viewName] = match
      const line = safe.slice(0, match.index).split('\n').length

      nodes.push({
        id: `view:${filePath}:${viewName}:${line}`,
        kind: 'component',
        name: viewName!,
        qualified_name: `${filePath}::${viewName}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'swift',
        updated_at: now,
      })
    }

    // Extract @main App entry point
    const appPattern = /@main\s+struct\s+(\w+)\s*:\s*App/g
    while ((match = appPattern.exec(safe)) !== null) {
      const [, appName] = match
      const line = safe.slice(0, match.index).split('\n').length

      nodes.push({
        id: `app:${filePath}:${appName}:${line}`,
        kind: 'class',
        name: appName!,
        qualified_name: `${filePath}::${appName}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'swift',
        updated_at: now,
      })
    }

    return { nodes, references: [] }
  },
}

export const uikitResolver: FrameworkResolver = {
  name: 'uikit',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles()
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file)
        if (content && (
          content.includes('import UIKit') ||
          content.includes('UIViewController') ||
          content.includes('UIView')
        )) {
          return true
        }
      }
    }
    return false
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: ViewController references
    if (ref.referenceName.endsWith('ViewController')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, VC_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 2: UIView subclass references
    if (ref.referenceName.endsWith('View') && !ref.referenceName.endsWith('ViewController')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, UIVIEW_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
      }
    }

    // Pattern 3: Cell references
    if (ref.referenceName.endsWith('Cell')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CELL_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 4: Delegate/DataSource references
    if (ref.referenceName.endsWith('Delegate') || ref.referenceName.endsWith('DataSource')) {
      const result = resolveByNameAndKind(ref.referenceName, PROTOCOL_KINDS, [], context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
      }
    }

    return null
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] }
    const nodes: NodeMetadata[] = []
    const now = Date.now()
    const safe = stripCommentsForRegex(content, 'swift')

    // Extract UIViewController subclasses
    const vcPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIViewController/g
    let match: RegExpExecArray | null
    while ((match = vcPattern.exec(safe)) !== null) {
      const [, vcName] = match
      const line = safe.slice(0, match.index).split('\n').length

      nodes.push({
        id: `viewcontroller:${filePath}:${vcName}:${line}`,
        kind: 'class',
        name: vcName!,
        qualified_name: `${filePath}::${vcName}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'swift',
        updated_at: now,
      })
    }

    // Extract UIView subclasses (not UIViewController)
    const viewPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIView[^C]/g
    while ((match = viewPattern.exec(safe)) !== null) {
      const [, viewName] = match
      const line = safe.slice(0, match.index).split('\n').length

      nodes.push({
        id: `uiview:${filePath}:${viewName}:${line}`,
        kind: 'class',
        name: viewName!,
        qualified_name: `${filePath}::${viewName}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'swift',
        updated_at: now,
      })
    }

    return { nodes, references: [] }
  },
}

export const vaporResolver: FrameworkResolver = {
  name: 'vapor',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    const packageSwift = context.readFile('Package.swift')
    if (packageSwift && packageSwift.includes('vapor')) {
      return true
    }

    const allFiles = context.getAllFiles()
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file)
        if (content && content.includes('import Vapor')) {
          return true
        }
      }
    }

    return false
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, VAPOR_CONTROLLER_KINDS, VAPOR_CONTROLLER_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 2: Model references (Fluent)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, FLUENT_MODEL_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.75, resolvedBy: 'framework' }
      }
    }

    // Pattern 3: Middleware references
    if (ref.referenceName.endsWith('Middleware')) {
      const result = resolveByNameAndKind(ref.referenceName, VAPOR_CONTROLLER_KINDS, VAPOR_MIDDLEWARE_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
      }
    }

    return null
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (!filePath.endsWith('.swift')) return { nodes: [], references: [] }
    const nodes: NodeMetadata[] = []
    const references: UnresolvedRef[] = []
    const now = Date.now()
    const safe = stripCommentsForRegex(content, 'swift')

    // Build group-var → path-prefix map
    const groupPrefix = new Map<string, string>()
    const segJoin = (existing: string, segsStr: string): string => {
      const segs = (segsStr.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1))
      return existing + segs.map((s) => '/' + s).join('')
    }
    let gm: RegExpExecArray | null
    // let X = Y.grouped("a", "b")
    const groupedRegex = /\blet\s+(\w+)\s*=\s*(\w+)\.grouped\s*\(([^)]*)\)/g
    while ((gm = groupedRegex.exec(safe)) !== null) {
      groupPrefix.set(gm[1]!, segJoin(groupPrefix.get(gm[2]!) ?? '', gm[3]!))
    }
    // Y.group("a") { X in ... }
    const groupClosureRegex = /\b(\w+)\.group\s*\(([^)]*)\)\s*\{\s*(\w+)\s+in/g
    while ((gm = groupClosureRegex.exec(safe)) !== null) {
      groupPrefix.set(gm[3]!, segJoin(groupPrefix.get(gm[1]!) ?? '', gm[2]!))
    }

    // Vapor: <builder>.METHOD([path segs,] use: handler)
    const routeRegex = /\b(\w+)\.(get|post|put|patch|delete|head|options)\s*\(\s*((?:[^,()]+,\s*)*)use:\s*([A-Za-z_][\w.]*)/g
    let match: RegExpExecArray | null
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, receiver, method, segsStr, handlerExpr] = match
      const line = safe.slice(0, match.index).split('\n').length
      const upper = method!.toUpperCase()
      const routePath = (groupPrefix.get(receiver!) ?? '') + segJoin('', segsStr!) || '/'

      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualified_name: `${filePath}::route:${routePath}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'swift',
        updated_at: now,
      }
      nodes.push(routeNode)

      // Last segment of dotted handler (self.list → list)
      const handlerName = handlerExpr!.split('.').pop()
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'swift',
        })
      }
    }

    return { nodes, references }
  },
}

// Directory patterns
const VIEW_DIRS = ['/Views/', '/View/', '/Screens/', '/Components/', '/UI/']
const VIEWMODEL_DIRS = ['/ViewModels/', '/ViewModel/', '/Stores/', '/Managers/', '/Services/']
const MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Domain/']
const VC_DIRS = ['/ViewControllers/', '/ViewController/', '/Controllers/', '/Screens/']
const UIVIEW_DIRS = ['/Views/', '/View/', '/UI/', '/Components/']
const CELL_DIRS = ['/Cells/', '/Cell/', '/Views/', '/TableViewCells/', '/CollectionViewCells/']
const VAPOR_CONTROLLER_DIRS = ['/Controllers/', '/Controller/', '/Routes/']
const FLUENT_MODEL_DIRS = ['/Models/', '/Model/', '/Entities/', '/Database/']
const VAPOR_MIDDLEWARE_DIRS = ['/Middleware/', '/Middlewares/']

const VIEW_KINDS = new Set(['struct', 'component'])
const CLASS_KINDS = new Set(['class'])
const MODEL_KINDS = new Set(['struct', 'class'])
const PROTOCOL_KINDS = new Set(['protocol'])
const VAPOR_CONTROLLER_KINDS = new Set(['class', 'struct'])

function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name)
  if (candidates.length === 0) return null

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind))
  if (kindFiltered.length === 0) return null

  if (preferredDirPatterns.length > 0) {
    const preferred = kindFiltered.filter((n) =>
      preferredDirPatterns.some((d) => n.file.includes(d))
    )
    if (preferred.length > 0) return preferred[0]!.id
  }

  return kindFiltered[0]!.id
}
