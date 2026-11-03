// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({
  user: { id: 'viewer-1', name: 'Viewer', email: 'viewer@example.test' },
}))

const apiMocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  apiRequest: apiMocks.apiRequest,
  resolveMediaUrl: (url: string) => url,
  uploadMedia: vi.fn(),
}))

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: authState.user }),
}))

import { ExplorePage } from '../src/pages/ExplorePage'
import { HomePage } from '../src/pages/HomePage'
import { ProfilePage } from '../src/pages/ProfilePage'

function NavigationHarness() {
  const navigate = useNavigate()
  return (
    <>
      <Routes>
        <Route path="/" element={<><HomePage /><button type="button" onClick={() => navigate('/away')}>Away</button></>} />
        <Route path="/away" element={<button type="button" onClick={() => navigate('/')}>Back to feed</button>} />
      </Routes>
    </>
  )
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  apiMocks.apiRequest.mockReset()
  authState.user = { id: 'viewer-1', name: 'Viewer', email: 'viewer@example.test' }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('fresh page data and navigation', () => {
  it('fetches the feed again on return instead of showing an old cached feed', async () => {
    const firstFeed = {
      id: 'post-1',
      author: { id: 'author-1', name: 'Author', handle: 'author', avatar: '' },
      createdAt: new Date().toISOString(),
      content: 'First current feed',
    }
    const secondFeed = { ...firstFeed, id: 'post-2', content: 'Updated current feed' }
    let resolveSecondFeed: ((value: { posts: unknown[] }) => void) | undefined
    let feedRequestCount = 0
    apiMocks.apiRequest.mockImplementation((path: string) => {
      if (path === '/api/posts?limit=50') {
        feedRequestCount += 1
        if (feedRequestCount === 1) return Promise.resolve({ posts: [firstFeed] })
        return new Promise((resolve) => { resolveSecondFeed = resolve })
      }
      if (path === '/api/stories') return Promise.resolve({ stories: [] })
      return Promise.resolve({})
    })

    await act(async () => {
      root.render(<MemoryRouter><NavigationHarness /></MemoryRouter>)
      await Promise.resolve()
    })
    expect(host.textContent).toContain('First current feed')

    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Away')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Back to feed')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(feedRequestCount).toBe(2)
    expect(host.querySelector('[aria-label="Loading your feed"]')).not.toBeNull()
    expect(host.textContent).not.toContain('First current feed')

    await act(async () => {
      resolveSecondFeed?.({ posts: [secondFeed] })
      await Promise.resolve()
    })
    expect(host.textContent).toContain('Updated current feed')
  })

  it('loads the current directory from the server', async () => {
    apiMocks.apiRequest.mockResolvedValue({
      users: [{
        id: 'person-1',
        name: 'Current directory result',
        handle: 'person',
        avatar: '',
        followerCount: 0,
      }],
    })

    await act(async () => {
      root.render(<MemoryRouter><ExplorePage /></MemoryRouter>)
      await Promise.resolve()
    })

    expect(apiMocks.apiRequest).toHaveBeenCalledWith('/api/users')
    expect(host.textContent).toContain('Current directory result')
  })

  it('loads the current profile and its posts from the server', async () => {
    apiMocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/users/profile-1') {
        return {
          user: {
            id: 'profile-1',
            name: 'Current profile',
            handle: 'profile',
            profile: { displayName: 'Current profile', username: 'profile' },
            followerCount: 0,
            followingCount: 0,
          },
        }
      }
      if (path === '/api/posts?limit=100') {
        return {
          posts: [{
            id: 'profile-post',
            author: { id: 'profile-1', name: 'Current profile', handle: 'profile', avatar: '' },
            createdAt: new Date().toISOString(),
            content: 'Current profile post',
          }],
        }
      }
      return {}
    })

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/profile/profile-1']}>
          <Routes><Route path="/profile/:id" element={<ProfilePage />} /></Routes>
        </MemoryRouter>,
      )
      await Promise.resolve()
    })

    expect(apiMocks.apiRequest).toHaveBeenCalledWith('/api/users/profile-1')
    expect(apiMocks.apiRequest).toHaveBeenCalledWith('/api/posts?limit=100')
    expect(host.textContent).toContain('Current profile')
    expect(host.textContent).toContain('Current profile post')
  })
})
