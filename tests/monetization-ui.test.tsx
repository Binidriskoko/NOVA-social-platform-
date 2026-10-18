// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  apiRequest: testState.apiRequest,
  fetchMediaBlob: vi.fn(),
  resolveMediaUrl: (url: string) => url,
}))

import { FeedAdSlot } from '../src/components/FeedAdSlot'
import { PostMedia } from '../src/components/PostMedia'
import { CreatorMonetizationPage } from '../src/pages/CreatorMonetizationPage'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  testState.apiRequest.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('creator and advertising UI', () => {
  it('flushes the final video position before closing playback on pause', async () => {
    testState.apiRequest.mockResolvedValue({})
    await act(async () => { root.render(<PostMedia url="https://cdn.example.test/clip.mp4" postId="post-1" />) })
    const video = host.querySelector('video')!
    Object.defineProperty(video, 'paused', { configurable: true, value: false })
    Object.defineProperty(video, 'duration', { configurable: true, value: 120 })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 })
    await act(async () => { video.dispatchEvent(new Event('play')) })
    video.currentTime = 31
    video.dispatchEvent(new Event('timeupdate'))
    Object.defineProperty(video, 'paused', { configurable: true, value: true })
    await act(async () => {
      video.dispatchEvent(new Event('pause'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(testState.apiRequest.mock.calls.map(([path]) => path)).toEqual([
      '/api/monetization/video-views/start',
      '/api/monetization/video-views/heartbeat',
      '/api/monetization/video-views/finish',
    ])
    expect(testState.apiRequest.mock.calls[1][1]?.body).toContain('"currentTimeSeconds":31')
  })

  it('shows unavailable creator metrics honestly and prevents an ineligible application', async () => {
    testState.apiRequest.mockResolvedValue({
      settings: { minimumPayoutCents: 500 },
      eligible: false,
      approved: false,
      active: false,
      metrics: { followers: 2, qualifiedViews: null, watchTimeSeconds: null, publicPosts: 1, engagements: 0, engagementRate: 0, accountAgeDays: 0 },
      requirements: [{ key: 'qualifiedViews', label: '1 qualified view', required: 1, actual: null, met: false, available: false }],
      applications: [],
      earnings: { entries: [], estimatedBalanceCents: 0, paidCents: 0, pendingPayoutCents: 0, payouts: [] },
    })
    await act(async () => { root.render(<CreatorMonetizationPage />) })
    expect(host.textContent).toContain('Ba a auna ba')
    const applyButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Nemi shiga'))
    expect(applyButton?.disabled).toBe(true)
    expect(testState.apiRequest).toHaveBeenCalledWith('/api/creators/me/monetization')
  })

  it('requires opt-in before serving ads and records only a returned impression click', async () => {
    testState.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/ads/consent' && options?.method === 'PUT') return { consented: true }
      if (path === '/api/ads/consent') return { consented: true, adsAvailable: true }
      if (path === '/api/ads/placements/feed') return { campaign: { id: 'campaign-1', name: 'Feed offer', creativeUrl: 'https://cdn.example.test/ad.png', destinationUrl: 'https://example.test/offer', impressionId: 'impression-1' } }
      return { duplicate: false }
    })
    testState.apiRequest.mockImplementationOnce(async () => ({ consented: false, adsAvailable: true }))
    await act(async () => { root.render(<FeedAdSlot />) })
    expect(host.textContent).toContain('Allow ads')
    expect(host.querySelector('img')).toBeNull()
    const optIn = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Allow ads')
    await act(async () => { optIn?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.textContent).toContain('Sponsored')
    const adLink = host.querySelector('a')
    expect(adLink?.getAttribute('href')).toBe('https://example.test/offer')
    await act(async () => { adLink?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(testState.apiRequest).toHaveBeenCalledWith('/api/ads/campaigns/campaign-1/events', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ eventType: 'CLICK', impressionId: 'impression-1' }),
    }))
  })
})
