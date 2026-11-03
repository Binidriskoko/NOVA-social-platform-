// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostMedia } from '../src/components/PostMedia'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  fetchMediaBlob: vi.fn(),
  resolveMediaUrl: vi.fn((url: string) => `https://api.test${url}`),
}))

vi.mock('../src/lib/api', () => mocks)

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = []
  target: Element | null = null

  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.instances.push(this)
  }

  observe = vi.fn((target: Element) => { this.target = target })
  disconnect = vi.fn()

  trigger() {
    this.callback([{ isIntersecting: true, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

let root: Root | null = null
let host: HTMLDivElement | null = null
let createObjectUrlDescriptor: PropertyDescriptor | undefined
let revokeObjectUrlDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  TestIntersectionObserver.instances = []
  mocks.apiRequest.mockReset()
  mocks.fetchMediaBlob.mockReset().mockResolvedValue(new Blob(['image']))
  mocks.resolveMediaUrl.mockClear()
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
  createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:post-media') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.unstubAllGlobals()
  if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (revokeObjectUrlDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
  vi.restoreAllMocks()
})

async function renderMedia(props: Parameters<typeof PostMedia>[0]) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(<PostMedia {...props} />))
}

describe('PostMedia loading and playback', () => {
  it('waits until an uploaded image nears the viewport before fetching it', async () => {
    await renderMedia({ url: '/api/media/uploads/image.jpg' })

    expect(host?.querySelector('[role="status"]')?.textContent).toContain('near the screen')
    expect(mocks.fetchMediaBlob).not.toHaveBeenCalled()

    await act(async () => {
      TestIntersectionObserver.instances[0].trigger()
      await Promise.resolve()
    })

    expect(mocks.fetchMediaBlob).toHaveBeenCalledOnce()
    expect(host?.querySelector('img')?.getAttribute('src')).toBe('blob:post-media')
    expect(host?.querySelector('img')?.getAttribute('decoding')).toBe('async')
  })

  it('does not preload or schedule heartbeat work for an inactive video', async () => {
    const setInterval = vi.spyOn(window, 'setInterval')
    await renderMedia({ url: '/api/media/files/clip.mp4', active: false, autoPlay: true, postId: 'post-1' })

    expect(host?.querySelector('video')?.getAttribute('preload')).toBe('none')
    expect(host?.querySelector('video')?.autoplay).toBe(false)
    expect(setInterval).not.toHaveBeenCalled()
    expect(mocks.fetchMediaBlob).not.toHaveBeenCalled()
  })

  it('retries autoplay after playback retry remounts the video element', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    await renderMedia({ url: 'https://cdn.example.test/clip.mp4', active: true, autoPlay: true })
    expect(play).toHaveBeenCalledOnce()

    await act(async () => {
      host?.querySelector('video')?.dispatchEvent(new Event('error'))
    })
    await act(async () => {
      [...(host?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Retry')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(play).toHaveBeenCalledTimes(2)
  })
})