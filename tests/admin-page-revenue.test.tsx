// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const adminMocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  user: { id: 'admin-1', name: 'Admin', email: 'admin@example.test', role: 'ADMIN' },
}))

vi.mock('../src/lib/api', () => ({ apiRequest: adminMocks.apiRequest }))
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ user: adminMocks.user }) }))

import { AdminPage } from '../src/pages/AdminPage'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  adminMocks.apiRequest.mockReset()
  adminMocks.apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/admin/dashboard') return { metrics: {} }
    if (path === '/api/admin/revenue') return {
      metrics: {
        grossRevenue: 12345,
        platformRevenue: 2345,
        creatorNetEarnings: 10000,
        pendingPayouts: 500,
        adSpendCents: 250,
        adImpressions: 17,
        adClicks: 3,
      },
    }
    if (path === '/api/admin/earnings') return {
      metrics: {
        estimatedEarningsCents: null,
        confirmedEarningsCents: 1200,
        pendingPayoutCents: 300,
        withdrawableBalanceCents: 900,
        paidCents: 400,
      },
      entries: [],
    }
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

describe('admin earnings and revenue dashboard', () => {
  it('loads real revenue metrics into the dashboard summary', async () => {
    await act(async () => {
      root.render(<AdminPage />)
      await Promise.resolve()
    })

    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Revenue'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(adminMocks.apiRequest).toHaveBeenCalledWith('/api/admin/revenue')
    expect(host.textContent).toContain('Gross revenue')
    expect(host.textContent).toContain('$123.45')
    expect(host.textContent).toContain('Platform revenue')
    expect(host.textContent).toContain('$23.45')
    expect(host.textContent).toContain('Creator earnings')
    expect(host.textContent).toContain('Ad impressions')
    expect(host.textContent).toContain('17')
  })

  it('shows confirmed earnings and states estimates are unavailable', async () => {
    await act(async () => {
      root.render(<AdminPage />)
      await Promise.resolve()
    })

    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Earnings'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(adminMocks.apiRequest).toHaveBeenCalledWith('/api/admin/earnings')
    expect(host.textContent).toContain('Confirmed earnings')
    expect(host.textContent).toContain('$12.00')
    expect(host.textContent).toContain('Not available until an estimate source is configured.')
  })
})
