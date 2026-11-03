// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiRequest } from '../src/lib/api'

function jsonResponse(value: unknown, cacheControl?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (cacheControl) headers.set('Cache-Control', cacheControl)
  return new Response(JSON.stringify(value), { status: 200, headers })
}

describe('API read cache', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/feature')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reuses fresh reads and fetches again after the short freshness window', async () => {
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'fresh' }))
      .mockResolvedValueOnce(jsonResponse({ value: 'updated' }))

    await expect(apiRequest('/api/test/short-lived-read')).resolves.toEqual({ value: 'fresh' })
    await expect(apiRequest('/api/test/short-lived-read')).resolves.toEqual({ value: 'fresh' })
    expect(fetchMock).toHaveBeenCalledOnce()

    now += 30_001
    await expect(apiRequest('/api/test/short-lived-read')).resolves.toEqual({ value: 'updated' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('invalidates cached reads when a write succeeds', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'before' }))
      .mockResolvedValueOnce(jsonResponse({ updated: true }))
      .mockResolvedValueOnce(jsonResponse({ value: 'after' }))

    await expect(apiRequest('/api/test/write-invalidation')).resolves.toEqual({ value: 'before' })
    await expect(apiRequest('/api/test/write-invalidation', { method: 'POST', body: '{}' })).resolves.toEqual({ updated: true })
    await expect(apiRequest('/api/test/write-invalidation')).resolves.toEqual({ value: 'after' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not cache responses marked no-store', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'first' }, 'private, no-store'))
      .mockResolvedValueOnce(jsonResponse({ value: 'second' }, 'private, no-store'))

    await expect(apiRequest('/api/test/no-store')).resolves.toEqual({ value: 'first' })
    await expect(apiRequest('/api/test/no-store')).resolves.toEqual({ value: 'second' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps Home feed reads uncached', async () => {
    window.history.replaceState(null, '', '/')
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: 'first Home feed' }))
      .mockResolvedValueOnce(jsonResponse({ value: 'current Home feed' }))

    await expect(apiRequest('/api/posts?limit=50')).resolves.toEqual({ value: 'first Home feed' })
    await expect(apiRequest('/api/posts?limit=50')).resolves.toEqual({ value: 'current Home feed' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
