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
  versionName: '1.1.0',
  versionCode: 2,
  releaseNotes: 'NOVAKOKO Android app. Download the APK, install it, and open the app.',
  releaseDate: '2026-10-18T23:18:44Z',
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

  it('fails closed when the public APK signing identity differs from the pinned release key', async () => {
    const script = await readFile(new URL('../scripts/build-android-release.mjs', import.meta.url), 'utf8')
    const gradle = await readFile(new URL('../android/app/build.gradle', import.meta.url), 'utf8')
    expect(script).toContain('publishedV110CertificateFingerprint')
    expect(script).toContain('refusing to publish until the signing-identity migration is explicitly resolved')
    expect(gradle).toContain('Refusing an unsigned Android release')
    expect(gradle).toContain("task.name in ['assembleRelease', 'bundleRelease']")
    expect(gradle).toContain('C81B2766C700A37A096C7A26F4F92DA73480F55F6221D1C660AC90F4508007DE')
    expect(gradle).toContain('Signing certificate does not match the pinned release certificate.')
  })

  it('rejects malformed or untrusted manifest values', () => {
    expect(() => parseReleaseMetadata({ ...currentRelease, versionCode: 0 })).toThrow(/versionCode/)
    expect(() => parseReleaseMetadata({ ...currentRelease, downloadPageUrl: 'http://example.com' }))
      .toThrow(/untrusted download page URL/)
  })

  it('only reports a release newer than the installed version', () => {
    const newerRelease = { ...currentRelease, versionCode: 3, versionName: '1.2.0' }
    expect(isUpdateAvailable(1, currentRelease)).toBe(true)
    expect(isUpdateAvailable(2, currentRelease)).toBe(false)
    expect(isUpdateAvailable(1, newerRelease)).toBe(true)
    expect(isUpdateAvailable(2, newerRelease)).toBe(true)
    expect(isUpdateAvailable(3, newerRelease)).toBe(false)
    expect(isUpdateAvailable(4, newerRelease)).toBe(false)
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
