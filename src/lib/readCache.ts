const maximumCachedReads = 20
const readCache = new Map<string, unknown>()

export function getCachedRead<T>(key: string): T | undefined {
  const value = readCache.get(key)
  if (value === undefined) return undefined
  readCache.delete(key)
  readCache.set(key, value)
  return value as T
}

export function setCachedRead<T>(key: string, value: T) {
  readCache.delete(key)
  readCache.set(key, value)
  if (readCache.size > maximumCachedReads) {
    const oldestKey = readCache.keys().next().value
    if (oldestKey !== undefined) readCache.delete(oldestKey)
  }
}

export function clearCachedRead(key: string) {
  readCache.delete(key)
}

export function clearCachedReads() {
  readCache.clear()
}
