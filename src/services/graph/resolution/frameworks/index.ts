/**
 * Framework Resolver Registry
 *
 * Manages framework-specific resolvers. Starts with an empty registry
 * that frameworks register into during Phase 6c-1/2/3.
 *
 * Migrated from codegraph/src/resolution/frameworks/index.ts — stripped of
 * all built-in framework imports (those will be added incrementally).
 */

import type { FrameworkResolver, ResolutionContext } from '../types.js'
import { reactResolver } from './react.js'
import { vueResolver } from './vue.js'
import { svelteResolver } from './svelte.js'
import { reactNativeBridgeResolver } from './react-native.js'
import { fabricViewResolver } from './fabric.js'
import { expoModulesResolver } from './expo-modules.js'
import { nestjsResolver } from './nestjs.js'
import { expressResolver } from './express.js'
import { javaResolver } from './java.js'

/**
 * All registered framework resolvers
 */
const FRAMEWORK_RESOLVERS: FrameworkResolver[] = []

/**
 * Get all framework resolvers
 */
export function getAllFrameworkResolvers(): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS
}

/**
 * Get a resolver by name
 */
export function getFrameworkResolver(name: string): FrameworkResolver | undefined {
  return FRAMEWORK_RESOLVERS.find((r) => r.name === name)
}

/**
 * Detect which frameworks are used in a project
 */
export function detectFrameworks(context: ResolutionContext): FrameworkResolver[] {
  return FRAMEWORK_RESOLVERS.filter((resolver) => {
    try {
      return resolver.detect(context)
    } catch {
      return false
    }
  })
}

/**
 * Filter a list of detected frameworks down to ones that apply to a given language.
 * Frameworks without an explicit `languages` list are treated as universal.
 */
export function getApplicableFrameworks(
  detected: FrameworkResolver[],
  language: string
): FrameworkResolver[] {
  return detected.filter(
    (fw) => !fw.languages || fw.languages.includes(language)
  )
}

/**
 * Register a custom framework resolver
 */
export function registerFrameworkResolver(resolver: FrameworkResolver): void {
  const index = FRAMEWORK_RESOLVERS.findIndex((r) => r.name === resolver.name)
  if (index !== -1) {
    FRAMEWORK_RESOLVERS.splice(index, 1)
  }
  FRAMEWORK_RESOLVERS.push(resolver)
}

/**
 * Reset all registered resolvers (for testing)
 */
export function resetFrameworkResolvers(): void {
  FRAMEWORK_RESOLVERS.length = 0
}

// Phase 6c-1: Register React + Vue + Svelte framework resolvers
registerFrameworkResolver(reactResolver)
registerFrameworkResolver(vueResolver)
registerFrameworkResolver(svelteResolver)

// Phase 6c-2: Register React Native + Fabric + Expo framework resolvers
registerFrameworkResolver(reactNativeBridgeResolver)
registerFrameworkResolver(fabricViewResolver)
registerFrameworkResolver(expoModulesResolver)

// Phase 6c-2: Register NestJS + Express + Java backend framework resolvers
registerFrameworkResolver(nestjsResolver)
registerFrameworkResolver(expressResolver)
registerFrameworkResolver(javaResolver)
