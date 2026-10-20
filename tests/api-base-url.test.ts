import { describe, expect, it } from 'vitest'
import capacitorConfig from '../capacitor.config'
import { resolveApiBaseUrl } from '../src/lib/apiBaseUrl'

const productionApiUrl = 'https://nova-social-platform-api.onrender.com'

describe('API base URL selection', () => {
  it('uses the production API for Android when no build-time URL is configured', () => {
    expect(resolveApiBaseUrl(undefined, 'android', true)).toBe(productionApiUrl)
  })

  it('keeps production browser requests same-origin for the Vercel API rewrite', () => {
    expect(resolveApiBaseUrl(undefined, 'web', true)).toBe('')
  })

  it('retains the production API fallback for local development', () => {
    expect(resolveApiBaseUrl(undefined, 'web', false)).toBe(productionApiUrl)
  })

  it('honors an explicitly configured API URL in local development', () => {
    expect(resolveApiBaseUrl('  http://localhost:4000/  ', 'web', false)).toBe('http://localhost:4000')
  })

  it('keeps Android on HTTPS for its native WebView origin', () => {
    expect(capacitorConfig.appId).toBe('com.novakoko.app')
    expect(capacitorConfig.server?.androidScheme).toBe('https')
  })
})
