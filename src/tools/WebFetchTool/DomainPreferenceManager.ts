import { LRUCache } from 'lru-cache'
import { STORAGE_KEYS, storageAdapter } from './constants.js'
import { webFetchConfigManager } from './WebFetchConfig.js'

export interface DomainPreference {
  domain: string
  action: 'allow' | 'deny' | 'skip'
  timestamp: number
  context?: {
    url?: string
    category?: string
  }
}

export interface UserDomainPreferences {
  allowedDomains: Set<string>
  deniedDomains: Set<string>
  recentConfirmations: DomainPreference[]
  preferences: Map<string, DomainPreference>
}

export class DomainPreferenceManager {
  private preferences: UserDomainPreferences
  private maxRecentConfirmations = 100
  private recentConfirmationsCache: LRUCache<string, DomainPreference>

  constructor() {
    this.preferences = this.loadPreferences()
    this.recentConfirmationsCache = new LRUCache({
      max: this.maxRecentConfirmations,
      ttl: 24 * 60 * 60 * 1000, // 24 hours
    })
    this.loadRecentConfirmationsToCache()
  }

  private loadPreferences(): UserDomainPreferences {
    try {
      const stored = storageAdapter.getItem(STORAGE_KEYS.DOMAIN_PREFERENCES)
      if (stored) {
        const parsed = JSON.parse(stored)
        return {
          allowedDomains: new Set(parsed.allowedDomains || []),
          deniedDomains: new Set(parsed.deniedDomains || []),
          recentConfirmations: parsed.recentConfirmations || [],
          preferences: new Map(parsed.preferences || []),
        }
      }
    } catch (error) {
      console.warn('Failed to load domain preferences:', error)
    }

    return {
      allowedDomains: new Set(),
      deniedDomains: new Set(),
      recentConfirmations: [],
      preferences: new Map(),
    }
  }

  private savePreferences(): void {
    try {
      storageAdapter.setItem(STORAGE_KEYS.DOMAIN_PREFERENCES, JSON.stringify({
        allowedDomains: Array.from(this.preferences.allowedDomains),
        deniedDomains: Array.from(this.preferences.deniedDomains),
        recentConfirmations: this.preferences.recentConfirmations,
        preferences: Array.from(this.preferences.preferences.entries()),
      }))
    } catch (error) {
      console.warn('Failed to save domain preferences:', error)
    }
  }

  private loadRecentConfirmationsToCache(): void {
    this.preferences.recentConfirmations.forEach(preference => {
      this.recentConfirmationsCache.set(preference.domain, preference)
    })
  }

  private addToRecentConfirmations(preference: DomainPreference): void {
    this.preferences.recentConfirmations.unshift(preference)
    if (this.preferences.recentConfirmations.length > this.maxRecentConfirmations) {
      this.preferences.recentConfirmations = this.preferences.recentConfirmations.slice(0, this.maxRecentConfirmations)
    }
    this.recentConfirmationsCache.set(preference.domain, preference)
    this.savePreferences()
  }

  /**
   * Check if a domain is allowed based on user preferences
   */
  isDomainAllowed(domain: string): boolean {
    return this.preferences.allowedDomains.has(domain)
  }

  /**
   * Check if a domain is denied based on user preferences
   */
  isDomainDenied(domain: string): boolean {
    return this.preferences.deniedDomains.has(domain)
  }

  /**
   * Get the last preference for a domain
   */
  getDomainPreference(domain: string): DomainPreference | null {
    return this.preferences.preferences.get(domain) || null
  }

  /**
   * Record a user's decision for a domain
   */
  recordDecision(domain: string, action: 'allow' | 'deny' | 'skip', url?: string, category?: string): void {
    const preference: DomainPreference = {
      domain,
      action,
      timestamp: Date.now(),
      context: {
        url,
        category,
      },
    }

    // Update preferences
    this.preferences.preferences.set(domain, preference)

    // Update allowed/denied sets
    if (action === 'allow') {
      this.preferences.allowedDomains.add(domain)
      this.preferences.deniedDomains.delete(domain)
    } else if (action === 'deny') {
      this.preferences.deniedDomains.add(domain)
      this.preferences.allowedDomains.delete(domain)
    }

    // Add to recent confirmations
    this.addToRecentConfirmations(preference)

    this.savePreferences()
  }

  /**
   * Check if we should ask for confirmation based on previous decisions and config
   */
  shouldAskForConfirmation(domain: string): boolean {
    // If domain is in allowed list, don't ask
    if (this.isDomainAllowed(domain)) {
      return false
    }

    // If domain is in denied list, don't ask
    if (this.isDomainDenied(domain)) {
      return false
    }

    // If decision remembering is disabled, always ask
    if (!webFetchConfigManager.shouldRememberDecisions()) {
      return true
    }

    // Check recent confirmations (within last 24 hours)
    const recent = this.recentConfirmationsCache.get(domain)
    if (recent && Date.now() - recent.timestamp < 24 * 60 * 60 * 1000) {
      // If the last decision was 'skip', we should ask again
      return recent.action !== 'allow' && recent.action !== 'deny'
    }

    return true
  }

  /**
   * Check if academic domains should be auto-allowed
   */
  shouldAutoAllowAcademic(domain: string): boolean {
    if (!webFetchConfigManager.shouldAllowAcademic()) {
      return false
    }

    return this.getDomainCategory(domain) === 'academic'
  }

  /**
   * Get domain category for better user experience
   */
  getDomainCategory(domain: string): string {
    const domainLower = domain.toLowerCase()

    if (domainLower.includes('arxiv.org') || domainLower.includes('research') || domainLower.includes('academia')) {
      return 'academic'
    }
    if (domainLower.includes('news') || domainLower.includes('bbc') || domainLower.includes('cnn')) {
      return 'news'
    }
    if (domainLower.includes('github') || domainLower.includes('stackoverflow') || domainLower.includes('developer')) {
      return 'tech'
    }
    if (domainLower.includes('gov') || domainLower.includes('gov.uk')) {
      return 'government'
    }
    if (domainLower.includes('edu') || domainLower.includes('university')) {
      return 'education'
    }
    if (domainLower.includes('facebook') || domainLower.includes('twitter') || domainLower.includes('instagram')) {
      return 'social_media'
    }
    if (domainLower.includes('amazon') || domainLower.includes('shop') || domainLower.includes('store')) {
      return 'ecommerce'
    }

    return 'unknown'
  }

  /**
   * Get smart suggestion for a domain based on history
   */
  getSuggestion(domain: string): 'allow' | 'deny' | 'skip' | null {
    const preference = this.getDomainPreference(domain)
    if (preference) {
      // If user has made a clear decision before, suggest the same
      if (preference.action === 'allow' || preference.action === 'deny') {
        return preference.action
      }
    }

    // For academic domains, suggest allow
    if (this.getDomainCategory(domain) === 'academic') {
      return 'allow'
    }

    return null
  }

  /**
   * Clear all preferences
   */
  clearAllPreferences(): void {
    this.preferences = {
      allowedDomains: new Set(),
      deniedDomains: new Set(),
      recentConfirmations: [],
      preferences: new Map(),
    }
    this.recentConfirmationsCache.clear()
    this.savePreferences()
  }

  /**
   * Get statistics about user preferences
   */
  getStatistics(): {
    totalDomains: number
    allowedDomains: number
    deniedDomains: number
    recentConfirmations: number
    categories: Record<string, number>
  } {
    const categories: Record<string, number> = {}
    this.preferences.preferences.forEach((pref, domain) => {
      const category = this.getDomainCategory(domain)
      categories[category] = (categories[category] || 0) + 1
    })

    return {
      totalDomains: this.preferences.preferences.size,
      allowedDomains: this.preferences.allowedDomains.size,
      deniedDomains: this.preferences.deniedDomains.size,
      recentConfirmations: this.preferences.recentConfirmations.length,
      categories,
    }
  }
}

// Global instance
export const domainPreferenceManager = new DomainPreferenceManager()