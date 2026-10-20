import { isVideoPostMediaUrl, postMediaFileType, POST_IMAGE_MAX_BYTES, POST_VIDEO_MAX_BYTES, validatePostMediaFile } from '../src/lib/postMedia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sidebarItems } from '../src/components/AppShell'
import { uploadVideo } from '../src/lib/api'
import { canonicalPostUrl, sharePostLink } from '../src/lib/postSharing'

describe('post media selection and video navigation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('accepts supported browser image and video types and rejects mismatches and oversized files', () => {
    const jpeg = new File(['image'], 'photo.jpeg', { type: 'image/jpeg' })
    const mp4 = new File(['video'], 'clip.mp4', { type: 'video/mp4' })
    const mismatched = new File(['video'], 'clip.mp4', { type: 'video/quicktime' })
    const acceptedLargeVideo = new File([new Uint8Array(11 * 1024 * 1024)], 'large.mp4', { type: 'video/mp4' })
    const oversizedVideo = new File([new Uint8Array(POST_VIDEO_MAX_BYTES + 1)], 'oversized.mp4', { type: 'video/mp4' })
    const oversizedImage = new File([new Uint8Array(POST_IMAGE_MAX_BYTES + 1)], 'large.png', { type: 'image/png' })

    expect(postMediaFileType(jpeg)?.kind).toBe('image')
    expect(postMediaFileType(mp4)?.kind).toBe('video')
    expect(validatePostMediaFile(jpeg)).toBe('')
    expect(validatePostMediaFile(mismatched)).toMatch(/Choose a JPEG/)
    expect(validatePostMediaFile(acceptedLargeVideo)).toBe('')
    expect(validatePostMediaFile(oversizedVideo)).toMatch(/100 MB or smaller/)
    expect(validatePostMediaFile(oversizedImage)).toMatch(/10 MB or smaller/)
    expect(isVideoPostMediaUrl('/api/media/files/video.mp4')).toBe(true)
    expect(isVideoPostMediaUrl('https://cdn.example.test/clip.webm?download=1')).toBe(true)
    expect(isVideoPostMediaUrl('/api/media/files/image.webp')).toBe(false)
  })

  it('routes Videos in the main navigation instead of showing a standalone Create destination', () => {
    expect(sidebarItems.some(({ label, path }) => label === 'Videos' && path === '/videos')).toBe(true)
    expect(sidebarItems.some(({ label, path }) => label === 'Create' || path === '/create')).toBe(false)
  })

  it('reports upload progress and completes only after the video upload API confirms success', async () => {
    const progress: number[] = []
    let requestUrl = ''
    let credentials = false
    const headers = new Map<string, string>()
    class MockUploadRequest {
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null }
      onerror: (() => void) | null = null
      ontimeout: (() => void) | null = null
      onabort: (() => void) | null = null
      onload: (() => void) | null = null
      status = 201
      responseText = JSON.stringify({ mediaUrl: '/api/media/files/123.mp4', contentType: 'video/mp4' })
      open(_method: string, url: string) { requestUrl = url }
      setRequestHeader(name: string, value: string) { headers.set(name, value) }
      getResponseHeader() { return 'application/json' }
      send(body: FormData) {
        expect(body.get('file')).toBeInstanceOf(File)
        this.upload.onprogress?.({ lengthComputable: true, total: 100, loaded: 51 } as ProgressEvent)
        this.onload?.()
      }
      set withCredentials(value: boolean) { credentials = value }
      get withCredentials() { return credentials }
      set timeout(_value: number) {}
    }
    vi.stubGlobal('localStorage', { getItem: () => null, removeItem: vi.fn() })
    vi.stubGlobal('XMLHttpRequest', MockUploadRequest)

    await expect(uploadVideo(new File(['video'], 'clip.mp4', { type: 'video/mp4' }), (value) => progress.push(value)))
      .resolves.toEqual({ mediaUrl: '/api/media/files/123.mp4', contentType: 'video/mp4' })
    expect(progress).toEqual([51, 100])
    expect(requestUrl).toMatch(/\/api\/media\/videos$/)
    expect(credentials).toBe(true)
  })
})

describe('post sharing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('builds the canonical hash route using the actual encoded post id', () => {
    expect(canonicalPostUrl('https://nova.test/', 'post/a b')).toBe('https://nova.test/#post-post%2Fa%20b')
  })

  it('uses native sharing when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { share })

    await expect(sharePostLink({ title: 'A post', text: 'Hello', url: 'https://example.test/#post-1' })).resolves.toBe('shared')
    expect(share).toHaveBeenCalledWith({ title: 'A post', text: 'Hello', url: 'https://example.test/#post-1' })
  })

  it('copies the link when native sharing is unavailable or fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText }, share: vi.fn().mockRejectedValue(new Error('Sharing unavailable')) })

    await expect(sharePostLink({ title: 'A post', text: 'Hello', url: 'https://example.test/#post-2' })).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith('https://example.test/#post-2')
  })

  it('does not record a share when the user cancels native sharing', async () => {
    vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')) })

    await expect(sharePostLink({ title: 'A post', text: 'Hello', url: 'https://example.test/#post-3' })).resolves.toBe('cancelled')
  })
})
