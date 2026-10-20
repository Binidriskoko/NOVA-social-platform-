import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authSessionReducer, initialAuthSessionState } from '../src/lib/authSession'
import { apiRequest, ApiError } from '../src/lib/api'
import { loginUser, logoutUser } from '../src/lib/auth'
import { openAuthenticatedEventStream } from '../src/lib/eventStream'
import { storeAccessToken } from '../src/lib/session'

const storedValues = new Map<string, string>()
const storage = {
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
  removeItem: (key: string) => storedValues.delete(key),
  clear: () => storedValues.clear(),
  key: (index: number) => [...storedValues.keys()][index] ?? null,
  get length() {
    return storedValues.size
  },
}

function createToken() {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `header.${payload}.signature`
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('browser authentication session', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    storedValues.clear()
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('persists login for a fresh /me request after module reload, then clears it on logout and revocation', async () => {
    const token = createToken()
    const user = { id: 'user_1', email: 'user@example.com', name: 'Nova User' }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user, token }))
      .mockResolvedValueOnce(jsonResponse({ user }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Logged out successfully.' }))
      .mockResolvedValueOnce(jsonResponse({ user, token }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Authentication required.' }, 401))

    await loginUser({ identifier: 'user@example.com', password: 'never-log-this-password' })
    expect([...storedValues.values()]).toContain(token)
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)

    vi.resetModules()
    const refreshedAuth = await import('../src/lib/auth')
    expect((await refreshedAuth.getCurrentUser())?.id).toBe(user.id)
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
    expect(fetchMock.mock.calls[1][1]?.credentials).toBe('include')

    await logoutUser()
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
    expect(storedValues.size).toBe(0)

    await refreshedAuth.loginUser({ identifier: 'user@example.com', password: 'never-log-this-password' })
    expect((await refreshedAuth.getCurrentUser())).toBeNull()
    expect(storedValues.size).toBe(0)
  })

  it('discards a locally stored token after its JWT expiry', async () => {
    const expiredPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 }))
    storage.setItem('novakoko.auth.access-token', `header.${expiredPayload}.signature`)

    vi.resetModules()
    const { getCurrentUser } = await import('../src/lib/auth')
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Authentication required.' }, 401))

    expect(await getCurrentUser()).toBeNull()
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBeNull()
    expect(storedValues.size).toBe(0)
  })

  it('ends initial loading after a /me network failure so public auth routes remain reachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const { getCurrentUser } = await import('../src/lib/auth')
    await expect(getCurrentUser()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(authSessionReducer(initialAuthSessionState, {
      type: 'verification-failed',
      message: 'Unable to reach the API.',
    })).toEqual({
      user: null,
      isLoading: false,
      authError: 'Unable to reach the API.',
    })
  })

  it('preserves a known authenticated user when /me has a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const { getCurrentUser } = await import('../src/lib/auth')
    await expect(getCurrentUser()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const authenticatedState = {
      user: { id: 'user_1', email: 'user@example.com', name: 'Nova User' },
      isLoading: true,
      authError: null,
    }
    expect(authSessionReducer(authenticatedState, {
      type: 'verification-failed',
      message: 'Unable to reach the API.',
    })).toEqual({
      user: authenticatedState.user,
      isLoading: false,
      authError: 'Unable to reach the API.',
    })
  })

  it('ends initial loading after a /me timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('The request timed out.', 'TimeoutError'))

    const { getCurrentUser } = await import('../src/lib/auth')
    await expect(getCurrentUser()).rejects.toMatchObject({ code: 'TIMEOUT', status: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(authSessionReducer(initialAuthSessionState, {
      type: 'verification-failed',
      message: 'The request timed out.',
    })).toEqual({
      user: null,
      isLoading: false,
      authError: 'The request timed out.',
    })
  })

  it.each([401, 403])('clears the session after /me confirms HTTP %i', async (status) => {
    storeAccessToken(createToken())
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Authentication required.' }, status))
    const { getCurrentUser } = await import('../src/lib/auth')
    const user = { id: 'user_1', email: 'user@example.com', name: 'Nova User' }
    const invalidSessionUser = await getCurrentUser()

    expect(invalidSessionUser).toBeNull()
    expect(storedValues.size).toBe(0)
    expect(authSessionReducer({
      user,
      isLoading: true,
      authError: null,
    }, {
      type: 'verification-succeeded',
      user: invalidSessionUser,
    })).toEqual({ user: null, isLoading: false, authError: null })
  })

  it('updates the authenticated user after successful /me verification', async () => {
    const user = { id: 'user_2', email: 'updated@example.com', name: 'Updated User' }
    fetchMock.mockResolvedValueOnce(jsonResponse({ user }))
    const { getCurrentUser } = await import('../src/lib/auth')
    const verifiedUser = await getCurrentUser()

    expect(authSessionReducer(initialAuthSessionState, {
      type: 'verification-succeeded',
      user: verifiedUser,
    })).toEqual({ user, isLoading: false, authError: null })
  })

  it('classifies HTTP errors for other API consumers without logging credentials', async () => {
    const token = createToken()
    storeAccessToken(token)
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Forbidden.' }, 403))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(apiRequest('/api/posts')).rejects.toMatchObject({
      code: 'AUTH_ERROR',
      status: 403,
    } satisfies Partial<ApiError>)
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
    expect(consoleLog).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Validation failed.' }, 422))
    await expect(apiRequest('/api/posts')).rejects.toMatchObject({
      code: 'API_ERROR',
      status: 422,
    })
  })

  it('returns parsed JSON from the shared API client', async () => {
    const posts = { posts: [{ id: 'post_1' }] }
    fetchMock.mockResolvedValueOnce(jsonResponse(posts))

    await expect(apiRequest('/api/posts', {
      headers: { Authorization: 'Bearer untrusted-test-header' },
    })).resolves.toEqual(posts)
    expect(fetchMock.mock.calls[0][0]).toBe('https://nova-social-platform-api.onrender.com/api/posts')
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)
  })

  it.each([
    [401, 'AUTH_ERROR'],
    [403, 'AUTH_ERROR'],
    [429, 'RATE_LIMITED'],
  ] as const)('keeps HTTP %i distinct from transport failures and does not retry it', async (status, code) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Request rejected.' }, status))

    await expect(apiRequest('/api/posts')).rejects.toMatchObject({
      code,
      status,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries safe reads after a transient gateway response', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'Temporarily unavailable.' }, 503))
      .mockResolvedValueOnce(jsonResponse({ posts: [] }))

    await expect(apiRequest('/api/posts')).resolves.toEqual({ posts: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off exponentially and caps retries for repeated gateway failures', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'Temporarily unavailable.' }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: 'Temporarily unavailable.' }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: 'Temporarily unavailable.' }, 503))

    const request = apiRequest('/api/posts')
    const assertion = expect(request).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      status: 503,
    })
    await vi.advanceTimersByTimeAsync(249)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(499)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await assertion
    vi.useRealTimers()
  })

  it('does not retry a failed authentication mutation', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(loginUser({ identifier: 'user@example.com', password: 'never-log-this-password' }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', status: null })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies browser fetch failures such as blocked CORS as transport errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(apiRequest('/api/posts')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: null,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('times out a request without retrying its mutation', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))

    const request = apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier: 'user@example.com', password: 'never-log-this-password' }),
    })
    const timeoutAssertion = expect(request).rejects.toMatchObject({ code: 'TIMEOUT', status: null })
    await vi.advanceTimersByTimeAsync(15000)
    await timeoutAssertion
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('preserves caller cancellation instead of reporting it as a timeout', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))

    const request = apiRequest('/api/posts', { signal: controller.signal })
    controller.abort(new DOMException('Cancelled by caller.', 'AbortError'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed successful response bodies as API errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>not JSON</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }))

    await expect(apiRequest('/api/posts')).rejects.toMatchObject({
      code: 'API_ERROR',
      status: 200,
    })
  })

  it('preserves status and content type for non-JSON API failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>upstream unavailable</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }))

    await expect(apiRequest('/api/posts', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'GATEWAY_ERROR',
      status: 502,
      message: 'The NOVAKOKO API gateway returned HTTP 502 with text/html content instead of JSON.',
      details: {
        contentType: 'text/html',
        body: '<html>upstream unavailable</html>',
        server: null,
        cfRay: null,
        cfMitigated: null,
      },
    })
  })

  it('distinguishes a Cloudflare HTML challenge from the application JSON rate limit', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '<!doctype html><html><title>Just a moment...</title>Cloudflare</html>',
      {
        status: 429,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'CF-Mitigated': 'challenge',
          'CF-Ray': 'test-ray-id',
          Server: 'cloudflare',
        },
      },
    ))

    await expect(apiRequest('/api/posts')).rejects.toMatchObject({
      code: 'CLOUDFLARE_CHALLENGE',
      status: 429,
      message: 'A Cloudflare Managed Challenge (HTTP 429) blocked the API request.',
      details: {
        contentType: 'text/html',
        server: 'cloudflare',
        cfRay: 'test-ray-id',
        cfMitigated: 'challenge',
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('extracts common structured error fields and classifies server and rate-limit statuses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Upstream rejected the request.' }, 503))
    await expect(apiRequest('/api/posts', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
      status: 503,
      message: 'Upstream rejected the request.',
    })

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429))
    await expect(apiRequest('/api/posts', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'The NOVAKOKO API is rate limiting requests (HTTP 429). Please wait and try again.',
    })
  })

  it('uses the same-origin API path in production for the Vercel Render proxy', async () => {
    vi.stubEnv('PROD', true)
    vi.resetModules()
    const {
      API_BASE_URL: productionApiBaseUrl,
      apiRequest: productionApiRequest,
      resolveMediaUrl: productionMediaUrl,
    } = await import('../src/lib/api')
    fetchMock.mockResolvedValueOnce(jsonResponse({ posts: [] }))

    expect(productionApiBaseUrl).toBe('')
    expect(productionMediaUrl('/api/media/avatar.webp')).toBe('/api/media/avatar.webp')
    await productionApiRequest('/api/posts')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/posts')
  })

  it('sends the persisted bearer session on authenticated real-time streams', async () => {
    const token = createToken()
    storeAccessToken(token)
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('event: ready\ndata: {"connected":true}\n\n'))
      },
    })))

    const stream = openAuthenticatedEventStream('/api/realtime')
    let readyEventData = ''
    stream.addEventListener('ready', (event) => { readyEventData = event.data })

    await vi.waitFor(() => expect(readyEventData).toBe('{"connected":true}'))
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include')
    stream.close()
  })

  it('backs off real-time reconnects after immediately closed streams', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    fetchMock.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) {
        controller.close()
      },
    })))

    const stream = openAuthenticatedEventStream('/api/realtime')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(499)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    stream.close()
  })
})
