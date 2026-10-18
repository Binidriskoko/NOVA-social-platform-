// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ apiRequest: vi.fn() }))

vi.mock('../src/lib/api', () => ({
  apiRequest: mocks.apiRequest,
  resolveMediaUrl: (url: string) => url,
  uploadMedia: vi.fn(),
  uploadVideo: vi.fn(),
}))
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'creator-1', name: 'Test Creator', email: 'creator@example.test' } }),
}))

import { CreatePage } from '../src/pages/CreatePage'
import { HomePage } from '../src/pages/HomePage'

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  mocks.apiRequest.mockReset()
  mocks.apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/posts?limit=50') return { posts: [] }
    if (path === '/api/stories') return { stories: [] }
    if (path === '/api/users/creator-1') return { user: { profile: { avatarUrl: '/avatar.webp' } } }
    return {}
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Create Post entry point', () => {
  it('opens the dedicated responsive Create Post screen from the Home composer', async () => {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/create" element={<CreatePage />} />
        </Routes>
        <CurrentPath />
      </MemoryRouter>)
      await Promise.resolve()
    })

    const openComposer = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes("What's on your mind?"))
    expect(openComposer).toBeDefined()
    await act(async () => {
      openComposer?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(host.querySelector('[data-testid="current-path"]')?.textContent).toBe('/create')
    expect(host.querySelector('h2')?.textContent).toBe('Create post')
    expect(host.textContent).toContain('Test Creator')
    expect(host.textContent).toContain('Photos / Videos')
    expect(host.textContent).toContain('Go Live')
    expect(host.querySelector('select[aria-label="Post privacy"]')).not.toBeNull()
    expect(host.querySelector('form')?.className).toContain('h-[100dvh]')
  })
})
