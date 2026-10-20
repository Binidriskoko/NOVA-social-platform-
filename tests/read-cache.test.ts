import { describe, expect, it } from 'vitest'
import { clearCachedRead, clearCachedReads, getCachedRead, setCachedRead } from '../src/lib/readCache'

describe('in-memory read cache', () => {
  it('isolates entries by key and supports safe account-scoped invalidation', () => {
    const firstUserKey = JSON.stringify(['messages', 'user-a', 'conversation'])
    const secondUserKey = JSON.stringify(['messages', 'user-b', 'conversation'])
    setCachedRead(firstUserKey, ['private message'])
    setCachedRead(secondUserKey, ['another private message'])

    expect(getCachedRead<string[]>(firstUserKey)).toEqual(['private message'])
    expect(getCachedRead<string[]>(secondUserKey)).toEqual(['another private message'])
    clearCachedRead(firstUserKey)
    expect(getCachedRead(firstUserKey)).toBeUndefined()
    expect(getCachedRead<string[]>(secondUserKey)).toEqual(['another private message'])
  })

  it('bounds retained read data', () => {
    for (let index = 0; index < 21; index += 1) setCachedRead(`bounded-${index}`, index)

    expect(getCachedRead('bounded-0')).toBeUndefined()
    expect(getCachedRead('bounded-20')).toBe(20)
  })

  it('clears all account-scoped entries on logout', () => {
    setCachedRead(JSON.stringify(['feed', 'user-a']), ['private post'])
    setCachedRead(JSON.stringify(['messages', 'user-a', 'conversation']), ['private message'])

    clearCachedReads()

    expect(getCachedRead(JSON.stringify(['feed', 'user-a']))).toBeUndefined()
    expect(getCachedRead(JSON.stringify(['messages', 'user-a', 'conversation']))).toBeUndefined()
  })
})
