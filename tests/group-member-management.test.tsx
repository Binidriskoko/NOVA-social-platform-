// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const testState = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  userId: 'owner-id',
  userName: 'Owner',
  conversations: [] as Array<Record<string, unknown>>,
  directory: [] as Array<{ id: string; name: string }>,
  directoryPromise: null as null | (() => Promise<{ users: Array<{ id: string; name: string }> }>),
}))

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: testState.userId, name: testState.userName }, isLoading: false }),
}))

vi.mock('../src/lib/api', () => ({
  apiRequest: testState.apiRequest,
  fetchMediaBlob: vi.fn(),
  resolveMediaUrl: (url: string | null | undefined) => url ?? '',
  uploadMedia: vi.fn(),
  uploadMessageAttachment: vi.fn(),
  uploadVideo: vi.fn(),
}))

vi.mock('../src/lib/eventStream', () => ({
  openAuthenticatedEventStream: vi.fn(() => ({ addEventListener: vi.fn(), close: vi.fn() })),
}))

import { MessagesPage } from '../src/pages/MessagesPage'

let root: Root | null = null
let host: HTMLDivElement

function seedGroup(ownerRole: 'OWNER' | 'MODERATOR' = 'OWNER') {
  testState.userId = ownerRole === 'OWNER' ? 'owner-id' : 'admin-id'
  testState.userName = ownerRole === 'OWNER' ? 'Owner' : 'Admin'
  testState.conversations = [{
    id: 'group-1',
    name: 'Test group',
    description: 'Group details',
    imageUrl: null,
    isGroup: true,
    isChannel: false,
    participants: [
      { userId: 'owner-id', role: 'OWNER', user: { id: 'owner-id', name: 'Owner', avatar: '' } },
      ...(ownerRole === 'MODERATOR' ? [{ userId: 'admin-id', role: 'MODERATOR', user: { id: 'admin-id', name: 'Admin', avatar: '' } }] : []),
      { userId: 'member-id', role: 'MEMBER', user: { id: 'member-id', name: 'Member', avatar: '' } },
    ],
    lastMessagePreview: null,
    updatedAt: '2026-10-17T10:00:00.000Z',
    lastMessageAt: null,
  }]
  testState.directory = [
    { id: 'member-id', name: 'Member' },
    { id: 'new-user-id', name: 'New User' },
    { id: 'another-user-id', name: 'Another User' },
  ]
}

function configureApi() {
  testState.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/conversations') return { conversations: testState.conversations }
    if (path === '/api/users') {
      if (testState.directoryPromise) return testState.directoryPromise()
      return { users: testState.directory }
    }
    if (path.includes('/messages?limit=50')) return { messages: [], hasMore: false }
    if (path.endsWith('/read')) return {}
    if (path.endsWith('/participants') && options?.method === 'POST') {
      const ids = (JSON.parse(String(options.body)) as { participantIds: string[] }).participantIds
      const conversation = testState.conversations[0]
      const participants = conversation.participants as Array<Record<string, unknown>>
      for (const id of ids) {
        const person = testState.directory.find((entry) => entry.id === id)!
        participants.push({ userId: id, role: 'MEMBER', user: { id, name: person.name, avatar: '' } })
      }
      return { added: ids }
    }
    const rolePath = path.match(/\/participants\/([^/]+)$/)
    if (rolePath && options?.method === 'PATCH') {
      const id = decodeURIComponent(rolePath[1])
      const participant = (testState.conversations[0].participants as Array<Record<string, unknown>>).find((entry) => entry.userId === id)!
      const { role } = JSON.parse(String(options.body)) as { role: string }
      participant.role = role
      return { participant }
    }
    if (rolePath && options?.method === 'DELETE') {
      const id = decodeURIComponent(rolePath[1])
      const conversation = testState.conversations[0]
      conversation.participants = (conversation.participants as Array<Record<string, unknown>>).filter((entry) => entry.userId !== id)
      return { removed: id }
    }
    return {}
  })
}

async function renderPage() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={['/messages']}><MessagesPage /></MemoryRouter>)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element | null) {
  if (!element) throw new Error('Expected control was not rendered.')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function openGroupDetails() {
  await click(host.querySelector('[aria-label="Open group details"]'))
}

describe('group member management UI', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })) })
    seedGroup()
    configureApi()
  })

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = null
    host?.remove()
    testState.apiRequest.mockReset()
    testState.directoryPromise = null
  })

  it.each(['OWNER', 'MODERATOR'] as const)('shows the add button and opens the real searchable add panel for %s', async (role) => {
    if (role === 'MODERATOR') seedGroup('MODERATOR')
    configureApi()
    await renderPage()
    await openGroupDetails()

    const addButton = host.querySelector<HTMLButtonElement>('[aria-label="Add group members"]')
    expect(addButton).not.toBeNull()
    await click(addButton)
    expect(host.querySelector('[aria-label="Search non-members"]')).not.toBeNull()
    expect(host.textContent).toContain('New User')
    expect(host.textContent).not.toContain('Everyone is already in this group.')
    expect(testState.apiRequest).toHaveBeenCalledWith('/api/users')
  })

  it('searches, adds a selected registered user, refreshes members, and promotes/demotes roles', async () => {
    await renderPage()
    await openGroupDetails()
    await click(host.querySelector('[aria-label="Add group members"]'))

    const search = host.querySelector<HTMLInputElement>('[aria-label="Search non-members"]')!
    const setSearch = async (value: string) => act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, value)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await setSearch('New User')
    expect(host.textContent).toContain('New User')
    expect(host.textContent).not.toContain('Another User')
    const newUserCheckbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((checkbox) => checkbox.closest('label')?.textContent?.includes('New User'))
    await click(newUserCheckbox ?? null)
    await setSearch('')
    const anotherUserCheckbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((checkbox) => checkbox.closest('label')?.textContent?.includes('Another User'))
    await click(anotherUserCheckbox ?? null)
    await click([...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Add selected')) ?? null)

    expect(testState.apiRequest).toHaveBeenCalledWith('/api/conversations/group-1/participants', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ participantIds: ['new-user-id', 'another-user-id'] }),
    }))
    expect(host.textContent).toContain('Members added.')
    expect(host.textContent).toContain('New User')

    await click(host.querySelector('[aria-label="Manage group member New User"]'))
    expect(host.textContent).toContain('Make admin')
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Make admin') ?? null)
    expect(testState.apiRequest).toHaveBeenCalledWith('/api/conversations/group-1/participants/new-user-id', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ role: 'MODERATOR' }),
    }))
    expect(host.textContent).toContain('Member role updated.')
    expect(host.querySelector('[aria-label="Manage group member New User"]')?.closest('li')?.textContent).toContain('Admin')

    await click(host.querySelector('[aria-label="Manage group member New User"]'))
    expect(host.textContent).toContain('Remove admin')
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Remove admin') ?? null)
    expect(testState.apiRequest).toHaveBeenCalledWith('/api/conversations/group-1/participants/new-user-id', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ role: 'MEMBER' }),
    }))
    expect(host.querySelector('[aria-label="Manage group member New User"]')?.closest('li')?.textContent).toContain('Member')
    await click(host.querySelector('[aria-label="Manage group member New User"]'))
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Remove from group') ?? null)
    expect(testState.apiRequest).toHaveBeenCalledWith('/api/conversations/group-1/participants/new-user-id', expect.objectContaining({ method: 'DELETE' }))
    expect(host.textContent).toContain('Member removed.')
    expect(host.querySelector('[aria-label="Manage group member New User"]')).toBeNull()
  })

  it('shows the directory loading and empty states', async () => {
    let resolveDirectory!: (response: { users: Array<{ id: string; name: string }> }) => void
    testState.directoryPromise = () => new Promise((resolve) => { resolveDirectory = resolve })
    configureApi()
    await renderPage()
    await openGroupDetails()
    await click(host.querySelector('[aria-label="Add group members"]'))
    expect(host.textContent).toContain('Loading members…')

    await act(async () => {
      resolveDirectory({ users: [{ id: 'member-id', name: 'Member' }] })
      await Promise.resolve()
    })
    expect(host.textContent).toContain('Everyone is already in this group.')

  })

  it('shows a useful error when the registered-user directory request fails', async () => {
    testState.apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/conversations') return { conversations: testState.conversations }
      if (path.includes('/messages?limit=50')) return { messages: [], hasMore: false }
      if (path.endsWith('/read')) return {}
      if (path === '/api/users') throw new Error('Directory unavailable')
      return {}
    })
    await renderPage()
    await openGroupDetails()
    await click(host.querySelector('[aria-label="Add group members"]'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Directory unavailable')
  })
})