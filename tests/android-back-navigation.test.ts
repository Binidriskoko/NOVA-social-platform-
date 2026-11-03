import { describe, expect, it } from 'vitest'
import { getAndroidBackAction } from '../src/lib/androidBackNavigation'

describe('Android back navigation', () => {
  it('returns to the previous route when the app has in-app history', () => {
    expect(getAndroidBackAction('/messages', 2)).toBe('history')
  })

  it('falls back to home for a deep link without an in-app history entry', () => {
    expect(getAndroidBackAction('/profile/123', 0)).toBe('home')
    expect(getAndroidBackAction('/videos', undefined)).toBe('home')
  })

  it('minimizes only when already at home without earlier app history', () => {
    expect(getAndroidBackAction('/', 0)).toBe('minimize')
    expect(getAndroidBackAction('/', undefined)).toBe('minimize')
    expect(getAndroidBackAction('/login', undefined)).toBe('minimize')
    expect(getAndroidBackAction('/appeal', undefined)).toBe('minimize')
  })
})