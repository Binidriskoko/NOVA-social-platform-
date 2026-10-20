// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let backButtonHandler: (() => void) | undefined
  return {
    apiRequest: vi.fn(async (path: string, _options?: RequestInit) => {
      if (path === '/api/conversations') {
        return {
          conversations: [{
            id: 'conversation-1',
            name: 'Alex',
            participants: [{ userId: 'peer-1', user: { id: 'peer-1', name: 'Alex' } }],
            lastMessagePreview: null,
            updatedAt: '2026-10-19T09:00:00Z',
            lastMessageAt: null,
          }],
        }
      }
      if (path.endsWith('/messages?limit=50')) return { messages: [], hasMore: false }
      return {}
    }),
    addListener: vi.fn(async (_event: string, listener: () => void) => {
      backButtonHandler = listener
      return { remove: vi.fn().mockResolvedValue(undefined) }
    }),
    getBackButtonHandler: () => backButtonHandler,
    openAuthenticatedEventStream: vi.fn(() => ({
      addEventListener: vi.fn(),
      close: vi.fn(),
    })),
  }
})

vi.mock('@capacitor/app', () => ({ App: { addListener: mocks.addListener } }))
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'current-user', name: 'Me' } }),
}))
vi.mock('../src/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  apiRequest: mocks.apiRequest,
  resolveMediaUrl: (url: string | null | undefined) => url ?? '',
  uploadMedia: vi.fn(),
  uploadMessageAttachment: vi.fn(),
  uploadVideo: vi.fn(),
}))
vi.mock('../src/lib/eventStream', () => ({
  openAuthenticatedEventStream: mocks.openAuthenticatedEventStream,
}))

import { MessagesPage } from '../src/pages/MessagesPage'

describe('Messages conversation back navigation', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.apiRequest.mockClear()
    mocks.addListener.mockClear()
    mocks.openAuthenticatedEventStream.mockClear()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns to chats with the draft intact using both the header and Android system Back', async () => {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/messages']}><MessagesPage /></MemoryRouter>)
      await Promise.resolve()
    })

    const alexConversation = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Alex'))
    expect(alexConversation).toBeTruthy()
    await act(async () => alexConversation?.click())

    const draft = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Type message"]')
    expect(draft).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(draft, 'keep this draft')
      draft?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const backButton = host.querySelector<HTMLButtonElement>('button[aria-label="Back to chats"]')
    expect(backButton).toBeTruthy()
    expect(backButton?.className).not.toContain('lg:hidden')
    await act(async () => backButton?.click())
    expect(host.querySelector('textarea[aria-label="Type message"]')).toBeNull()

    const reopenedConversation = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Alex'))
    await act(async () => reopenedConversation?.click())
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Type message"]')?.value)
      .toBe('keep this draft')

    const hardwareBack = mocks.getBackButtonHandler()
    expect(hardwareBack).toBeTypeOf('function')
    await act(async () => hardwareBack?.())
    expect(host.querySelector('textarea[aria-label="Type message"]')).toBeNull()

    const sendRequests = mocks.apiRequest.mock.calls
      .filter(([path, options]) => path.endsWith('/messages') && options?.method === 'POST')
    expect(sendRequests).toHaveLength(0)
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Alex'))).toBe(true)
  })
})
