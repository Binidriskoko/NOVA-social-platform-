// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  resolveMediaUrl: vi.fn((url: string) => `https://api.test${url}`),
  fetchMediaBlob: vi.fn(),
}))

vi.mock('../src/lib/api', () => apiMocks)

import { VideosPage } from '../src/pages/VideosPage'

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = []
  targets: Element[] = []

  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.instances.push(this)
  }

  observe = vi.fn((target: Element) => { this.targets.push(target) })
  disconnect = vi.fn()

  trigger(target: Element) {
    this.callback([{ isIntersecting: true, intersectionRatio: 1, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  sessionStorage.clear()
  apiMocks.apiRequest.mockReset().mockResolvedValue({
    posts: ['one', 'two'].map((id) => ({
      id,
      author: { id: 'creator', name: 'Creator', handle: 'creator', avatar: '' },
      createdAt: new Date().toISOString(),
      content: '',
      imageUrl: `https://cdn.test/${id}.mp4`,
      likes: 0,
      comments: 0,
      shares: 0,
      saved: 0,
    })),
  })
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  TestIntersectionObserver.instances = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VideosPage sound preference', () => {
  it('keeps sound enabled as autoplay advances and when the page is reopened', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    await act(async () => {
      root.render(<VideosPage />)
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    const videos = host.querySelectorAll('video')
    expect(videos).toHaveLength(2)
    expect(videos[0].muted).toBe(true)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Turn video sound on"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(videos[0].muted).toBe(false)
    expect(sessionStorage.getItem('novachat.video-sound')).toBe('on')
    expect(videos[1].muted).toBe(false)

    const observer = TestIntersectionObserver.instances.at(-1)!
    expect(observer.targets).toHaveLength(2)
    observer.trigger(observer.targets.at(-1)!)
    await act(async () => { await Promise.resolve() })
    expect(videos[0].getAttribute('src')).toBeNull()
    expect(videos[1].autoplay).toBe(true)
    expect(videos[1].muted).toBe(false)

    await act(async () => { root.render(null) })
    await act(async () => {
      root.render(<VideosPage />)
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    const resumedVideos = host.querySelectorAll('video')
    expect(resumedVideos).toHaveLength(2)
    expect(resumedVideos[0].muted).toBe(false)
    expect(resumedVideos[1].muted).toBe(false)
  })
})
