// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountAppealPage } from '../src/pages/AccountAppealPage'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  refreshCurrentUser: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({ apiRequest: mocks.apiRequest }))
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ refreshCurrentUser: mocks.refreshCurrentUser, logout: mocks.logout }),
}))

describe('account appeal page', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    mocks.apiRequest.mockResolvedValue({ appeals: [], persistence: 'in-memory' })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.clearAllMocks()
  })

  it('loads prior appeals and offers a reason form when no appeal is pending', async () => {
    await act(async () => {
      root.render(<MemoryRouter><AccountAppealPage /></MemoryRouter>)
      await Promise.resolve()
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/auth/appeals/me')
    expect(host.querySelector('h1')?.textContent).toBe('Your account is restricted')
    expect(host.querySelector('label[for="appeal-reason"]')).not.toBeNull()
    expect(host.querySelector('textarea[required]')).not.toBeNull()
    expect(host.textContent).toContain('temporary in-memory storage')
  })
})
