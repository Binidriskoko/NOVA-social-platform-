import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { RELEASE_METADATA_URL } from '../src/config/release'
import {
  fetchReleaseMetadata,
  isUpdateAvailable,
  parseReleaseMetadata,
} from '../src/lib/releaseMetadata'
import type { ReleaseMetadata } from '../src/lib/releaseMetadata'

const currentRelease: ReleaseMetadata = {
  versionName: '1.0.0',
  versionCode: 1,
  releaseNotes: 'Initial public Android release.',
  releaseDate: '2026-10-02T05:15:03Z',
  minSupportedVersionCode: 1,
  downloadPageUrl: 'https://github.com/Binidriskoko/NOVA-social-platform-/releases/latest',
}

describe('Android release metadata', () => {
  it('accepts the checked-in manifest', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../public/release-metadata.json', import.meta.url), 'utf8'),
    ) as unknown
    expect(parseReleaseMetadata(manifest)).toEqual(currentRelease)
  })

  it('keeps the Android Gradle and app-side installed version in sync', async () => {
    const [gradle, releaseConfig] = await Promise.all([
      readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8'),
      readFile(new URL('../src/config/release.ts', import.meta.url), 'utf8'),
    ])
    expect(releaseConfig.match(/ANDROID_VERSION_CODE\s*=\s*(\d+)/)?.[1])
      .toBe(gradle.match(/versionCode\s+(\d+)/)?.[1])
    expect(releaseConfig.match(/APP_VERSION_NAME\s*=\s*'([^']+)'/)?.[1])
      .toBe(gradle.match(/versionName\s+"([^"]+)"/)?.[1])
  })

  it('rejects malformed or untrusted manifest values', () => {
    expect(() => parseReleaseMetadata({ ...currentRelease, versionCode: 0 })).toThrow(/versionCode/)
    expect(() => parseReleaseMetadata({ ...currentRelease, downloadPageUrl: 'http://example.com' }))
      .toThrow(/untrusted download page URL/)
  })

  it('only reports a release newer than the installed version', () => {
    const newerRelease = { ...currentRelease, versionCode: 2, versionName: '1.1.0' }
    expect(isUpdateAvailable(1, currentRelease)).toBe(false)
    expect(isUpdateAvailable(1, newerRelease)).toBe(true)
    expect(isUpdateAvailable(2, newerRelease)).toBe(false)
    expect(isUpdateAvailable(3, newerRelease)).toBe(false)
    expect(isUpdateAvailable(0, newerRelease)).toBe(false)
  })

  it('surfaces offline failures for the UI to handle without blocking app startup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'))
    await expect(fetchReleaseMetadata(fetcher)).rejects.toThrow('offline')
  })

  it('loads valid metadata and reports HTTP failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(currentRelease), { status: 200 }),
    )
    await expect(fetchReleaseMetadata(fetcher)).resolves.toEqual(currentRelease)
    expect(fetcher).toHaveBeenCalledWith(RELEASE_METADATA_URL, { cache: 'no-cache' })

    const rateLimitedFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('', { status: 429 }),
    )
    await expect(fetchReleaseMetadata(rateLimitedFetcher)).rejects.toThrow('HTTP 429')
  })
})
