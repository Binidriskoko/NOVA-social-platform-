import { clearStoredAccessToken, getStoredAccessToken } from './session'

const productionApiBaseUrl = 'https://nova-social-platform-api.onrender.com'
const configuredApiBaseUrl = import.meta.env.PROD
  ? ''
  : import.meta.env.VITE_API_BASE_URL?.trim() || productionApiBaseUrl

export const API_BASE_URL = configuredApiBaseUrl.replace(/\/$/, '')

export function resolveMediaUrl(url: string | null | undefined) {
  if (!url) return '';
  return url.startsWith('/api/media/') ? `${API_BASE_URL}${url}` : url;
}

async function uploadFile(path: string, file: File, onProgress?: (progress: number) => void) {
  const body = new FormData();
  body.append('file', file);
  const headers = new Headers()
  const accessToken = getStoredAccessToken()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)

  return new Promise<{ mediaUrl: string; contentType: string }>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `${API_BASE_URL}${path}`)
    request.withCredentials = true
    request.timeout = path === '/api/media/videos' ? 5 * 60 * 1000 : 30000
    headers.forEach((value, key) => request.setRequestHeader(key, value))
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(99, Math.floor(event.loaded / event.total * 100)))
    }
    request.onerror = () => reject(new ApiError(null, 'Unable to reach the NOVAKOKO API. Check your connection and try again shortly.', undefined, 'NETWORK_ERROR'))
    request.ontimeout = () => reject(new ApiError(null, 'The NOVAKOKO upload timed out. Please try again shortly.', undefined, 'TIMEOUT'))
    request.onabort = () => reject(new DOMException('The upload was cancelled.', 'AbortError'))
    request.onload = () => {
      const contentType = request.getResponseHeader('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
      let payload: unknown
      try {
        payload = JSON.parse(request.responseText)
      } catch {
        if (request.status >= 200 && request.status < 300) {
          reject(new ApiError(request.status, 'The NOVAKOKO API returned an invalid upload response.'))
        } else {
          reject(new ApiError(request.status, `The NOVAKOKO API returned HTTP ${request.status} while uploading.`))
        }
        return
      }
      if (request.status < 200 || request.status >= 300) {
        if (request.status === 401) clearStoredAccessToken()
        reject(new ApiError(request.status, extractErrorMessage(payload, `Unable to upload media (HTTP ${request.status}).`), payload))
        return
      }
      if (contentType !== 'application/json' || typeof payload !== 'object' || payload === null
        || typeof (payload as { mediaUrl?: unknown }).mediaUrl !== 'string'
        || typeof (payload as { contentType?: unknown }).contentType !== 'string') {
        reject(new ApiError(request.status, 'The NOVAKOKO API returned an invalid upload response.'))
        return
      }
      onProgress?.(100)
      resolve(payload as { mediaUrl: string; contentType: string })
    }
    request.send(body)
  })
}

export function uploadMedia(file: File, onProgress?: (progress: number) => void) {
  return uploadFile('/api/media/uploads', file, onProgress)
}

export function uploadVideo(file: File, onProgress?: (progress: number) => void) {
  return uploadFile('/api/media/videos', file, onProgress)
}

export async function uploadMessageAttachment(file: File) {
  const body = new FormData();
  body.append('file', file);
  return apiRequest<{ mediaUrl: string; contentType: string }>('/api/media/attachments', {
    method: 'POST',
    body,
  });
}

export async function fetchMediaBlob(mediaUrl: string, signal: AbortSignal) {
  const headers = new Headers()
  const accessToken = getStoredAccessToken()
  if (accessToken) headers.set('Authorization', `******`)
  const response = await fetch(resolveMediaUrl(mediaUrl), { credentials: 'include', headers, signal })
  if (!response.ok) throw new ApiError(response.status, 'Unable to load this attachment.')
  return response.blob()
}

export class ApiError extends Error {
  status: number | null
  details?: unknown
  code: ApiErrorCode

  constructor(status: number | null, message: string, details?: unknown, code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
    this.code = code ?? (
      status === 401 || status === 403
        ? 'AUTH_ERROR'
        : status === 429
          ? 'RATE_LIMITED'
          : status !== null && status >= 500
            ? 'SERVER_ERROR'
            : 'API_ERROR'
    )
  }
}

export type ApiErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'GATEWAY_ERROR'
  | 'CLOUDFLARE_CHALLENGE'
  | 'API_ERROR'

function waitBeforeRetry(attempt: number) {
  const exponentialDelay = Math.min(500 * 2 ** attempt, 2000)
  const jitteredDelay = exponentialDelay * (0.5 + Math.random() * 0.5)
  return new Promise((resolve) => setTimeout(resolve, jitteredDelay))
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function createTransportError(code: 'NETWORK_ERROR' | 'TIMEOUT') {
  const message = code === 'TIMEOUT'
    ? 'The NOVAKOKO API request timed out. Please try again shortly.'
    : 'Unable to reach the NOVAKOKO API. Check your connection and try again shortly.'
  return new ApiError(null, message, undefined, code)
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload !== 'object' || payload === null) {
    return fallback
  }

  const data = payload as { message?: unknown; error?: unknown; detail?: unknown; errors?: unknown }

  for (const message of [data.message, data.error, data.detail]) {
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  }

  if (data.errors && typeof data.errors === 'object') {
    const errorEntries = Object.values(data.errors as Record<string, unknown>)
    const flattened = errorEntries.find((value) => {
      if (Array.isArray(value)) {
        return value.some((item) => typeof item === 'string' && item.trim())
      }

      return typeof value === 'string' && value.trim()
    })

    if (Array.isArray(flattened)) {
      const message = flattened.find((item) => typeof item === 'string' && item.trim())
      if (typeof message === 'string') {
        return message
      }
    }

    if (typeof flattened === 'string' && flattened.trim()) {
      return flattened
    }
  }

  return fallback
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const isSafeRead = (options.method ?? 'GET').toUpperCase() === 'GET'
  const maxAttempts = isSafeRead ? 3 : 1
  const isCredentialSubmission = path === '/api/auth/login' || path === '/api/auth/register'
  const accessToken = isCredentialSubmission ? null : getStoredAccessToken()

  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`)
  } else {
    headers.delete('Authorization')
  }

  let response: Response | undefined
  let rawText = ''
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    response = undefined
    rawText = ''
    const controller = new AbortController()
    let timedOut = false
    let retryTransportFailure = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('The request timed out.', 'TimeoutError'))
    }, 15000)
    const abortFromRequest = () => controller.abort(options.signal?.reason)

    if (options.signal?.aborted) {
      abortFromRequest()
    } else {
      options.signal?.addEventListener('abort', abortFromRequest, { once: true })
    }

    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        credentials: 'include',
        headers,
        signal: controller.signal,
      })
      if (!(isSafeRead && [502, 503, 504].includes(response.status) && attempt < maxAttempts - 1)) {
        rawText = await response.text()
      } else {
        await response.body?.cancel()
      }
    } catch (error) {
      const callerAborted = options.signal?.aborted ?? false
      const isTimeout = timedOut || (!callerAborted && isAbortError(error))
      const isNetworkError = error instanceof TypeError
      retryTransportFailure = isSafeRead
        && !callerAborted
        && attempt < maxAttempts - 1
        && (isTimeout || isNetworkError)

      if (!retryTransportFailure && isTimeout) {
        throw createTransportError('TIMEOUT')
      }
      if (!retryTransportFailure && callerAborted) {
        throw error
      }
      if (!retryTransportFailure && isNetworkError) {
        throw createTransportError('NETWORK_ERROR')
      }
      if (!retryTransportFailure) throw error
    } finally {
      clearTimeout(timeoutId)
      options.signal?.removeEventListener('abort', abortFromRequest)
    }

    if (retryTransportFailure) {
      await waitBeforeRetry(attempt)
      continue
    }

    if (response && isSafeRead && [502, 503, 504].includes(response.status) && attempt < maxAttempts - 1) {
      await waitBeforeRetry(attempt)
      continue
    }

    break
  }

  if (!response) {
    throw createTransportError('NETWORK_ERROR')
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
  const hasJsonContentType = contentType === 'application/json' || contentType.endsWith('+json')
  const responseServer = response.headers.get('server')
  const cfMitigated = response.headers.get('cf-mitigated')
  const cfRay = response.headers.get('cf-ray')

  if (!response.ok && !hasJsonContentType) {
    if (response.status === 401) {
      clearStoredAccessToken()
    }

    const isHtmlResponse = contentType === 'text/html'
      || /^\s*(?:<!doctype html|<html)/i.test(rawText)
    const isCloudflareChallenge = response.status === 429
      && isHtmlResponse
      && (
        cfMitigated?.toLowerCase() === 'challenge'
        || /cloudflare|cf-browser-verification|cf_chl_/i.test(rawText)
      )
    const details = {
      contentType: contentType || null,
      body: rawText,
      server: responseServer,
      cfRay,
      cfMitigated,
    }

    if (isCloudflareChallenge) {
      throw new ApiError(
        response.status,
        'A Cloudflare Managed Challenge (HTTP 429) blocked the API request.',
        details,
        'CLOUDFLARE_CHALLENGE',
      )
    }

    throw new ApiError(
      response.status,
      `The NOVAKOKO API gateway returned HTTP ${response.status} with ${contentType || 'an unlabelled'} content instead of JSON.`,
      details,
      'GATEWAY_ERROR',
    )
  }

  let payload: unknown
  try {
    payload = rawText ? JSON.parse(rawText) : undefined
  } catch {
    if (response.ok) {
      throw new ApiError(response.status, 'The NOVAKOKO API returned an invalid response.')
    }
    payload = { contentType: contentType || null, body: rawText }
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearStoredAccessToken()
    }
    const fallback = response.status === 429
      ? 'The NOVAKOKO API is rate limiting requests (HTTP 429). Please wait and try again.'
      : response.status >= 500
        ? `The NOVAKOKO API is temporarily unavailable (HTTP ${response.status}). Please try again shortly.`
        : `The NOVAKOKO API request failed with HTTP ${response.status}.`
    throw new ApiError(response.status, extractErrorMessage(payload, fallback), payload)
  }

  return payload as T
}
