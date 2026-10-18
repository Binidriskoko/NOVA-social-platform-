// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  apiRequest: mocks.apiRequest,
  uploadVideo: vi.fn(),
}))
vi.mock('../src/lib/eventStream', () => ({
  openAuthenticatedEventStream: () => ({ addEventListener: vi.fn(), close: vi.fn() }),
}))
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'creator-1', name: 'Test Creator' } }),
}))
vi.mock('../src/components/PostMedia', () => ({
  PostMedia: ({ alt }: { alt: string }) => <video aria-label={alt} />,
}))

import { LivePage } from '../src/pages/LivePage'

const replay = {
  id: 'live-1',
  title: 'Community update',
  mediaUrl: '/api/media/files/video.webm',
  durationSeconds: 42,
  status: 'READY',
  createdAt: '2026-10-18T12:00:00.000Z',
  publishedPostId: null,
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  mocks.apiRequest.mockReset()
  mocks.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/live') return { lives: [] }
    if (path === '/api/live/replays') return { replays: [replay] }
    if (path === '/api/live/live-1/replay/publish' && options?.method === 'POST') {
      return { replay: { ...replay, status: 'PUBLISHED' }, post: { id: 'post-1' }, duplicate: false }
    }
    if (path === '/api/live/live-1/replay' && options?.method === 'DELETE') return { deleted: true }
    throw new Error(`Unexpected API request: ${path}`)
  })
  vi.stubGlobal('confirm', vi.fn(() => true))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function renderLivePage() {
  await act(async () => {
    root.render(<MemoryRouter><LivePage /></MemoryRouter>)
    await Promise.resolve()
  })
}

function clickButton(label: string) {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`Button not found: ${label}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('live replay actions', () => {
  it('previews a recorded replay and posts a feed entry with the replay reference', async () => {
    await renderLivePage()
    await act(async () => { clickButton('SAVE AND POST'); await Promise.resolve() })

    expect(host.querySelector('video[aria-label="Community update live replay"]')).not.toBeNull()
    expect(host.textContent).toContain('Save and post')
    await act(async () => { clickButton('Save and post'); await Promise.resolve() })

    const publish = mocks.apiRequest.mock.calls.find(([path]) => path === '/api/live/live-1/replay/publish')
    expect(publish?.[1]).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(publish?.[1]?.body))).toMatchObject({ content: replay.title, visibility: 'PUBLIC' })
    expect(host.textContent).not.toContain('Your live replay is saved')
  })

  it('keeps the post-live screen available after a network failure so posting can be retried', async () => {
    let publishAttempts = 0
    mocks.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/live') return { lives: [] }
      if (path === '/api/live/replays') return { replays: [replay] }
      if (path === '/api/live/live-1/replay/publish' && options?.method === 'POST') {
        publishAttempts += 1
        if (publishAttempts === 1) throw new Error('Connection timed out.')
        return { replay: { ...replay, status: 'PUBLISHED', publishedPostId: 'post-1' }, post: { id: 'post-1' }, duplicate: false }
      }
      throw new Error(`Unexpected API request: ${path}`)
    })
    await renderLivePage()
    await act(async () => { clickButton('SAVE AND POST'); await Promise.resolve() })
    await act(async () => {
      clickButton('Save and post')
      clickButton('Save and post')
      await Promise.resolve()
    })

    expect(publishAttempts).toBe(1)
    expect(host.textContent).toContain('Connection timed out.')
    expect(host.textContent).toContain('Your live replay is saved')
    expect(host.textContent).toContain('Save and post')
    await act(async () => { clickButton('Save and post'); await Promise.resolve() })
    expect(publishAttempts).toBe(2)
    expect(host.textContent).not.toContain('Your live replay is saved')
  })

  it('keeps posted recordings playable and links back to the feed post', async () => {
    mocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/live') return { lives: [] }
      if (path === '/api/live/replays') return { replays: [{ ...replay, status: 'PUBLISHED', publishedPostId: 'post-1' }] }
      throw new Error(`Unexpected API request: ${path}`)
    })
    await renderLivePage()
    await act(async () => { clickButton('PREVIEW'); await Promise.resolve() })

    expect(host.querySelector('video[aria-label="Community update live replay"]')).not.toBeNull()
    expect(host.querySelector('a[href="/profile"]')?.textContent).toBe('View post')
  })

  it('deletes a replay through the owner action and removes it from the list', async () => {
    await renderLivePage()
    await act(async () => { clickButton('DELETE'); await Promise.resolve() })
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-1/replay', { method: 'DELETE' })
    expect(host.textContent).not.toContain('Community update')
  })

  it('keeps Delete retryable when a weak connection interrupts the request', async () => {
    let deleteAttempts = 0
    mocks.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/live') return { lives: [] }
      if (path === '/api/live/replays') return { replays: [replay] }
      if (path === '/api/live/live-1/replay' && options?.method === 'DELETE') {
        deleteAttempts += 1
        if (deleteAttempts === 1) throw new Error('Connection lost.')
        return { deleted: true }
      }
      throw new Error(`Unexpected API request: ${path}`)
    })
    await renderLivePage()
    await act(async () => { clickButton('DELETE'); await Promise.resolve() })
    expect(host.textContent).toContain('Connection lost.')
    expect(host.textContent).toContain('Community update')
    await act(async () => { clickButton('DELETE'); await Promise.resolve() })
    expect(deleteAttempts).toBe(2)
    expect(host.textContent).not.toContain('Community update')
  })
})
