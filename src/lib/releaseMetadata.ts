import { RELEASE_DOWNLOAD_PAGE_URL, RELEASE_METADATA_URL } from '../config/release'

export type ReleaseMetadata = {
  versionName: string
  versionCode: number
  releaseNotes: string
  releaseDate: string
  minSupportedVersionCode: number
  downloadPageUrl: string
}

export function parseReleaseMetadata(value: unknown): ReleaseMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Release metadata must be an object.')
  }

  const metadata = value as Record<string, unknown>
  if (typeof metadata.versionName !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.versionName)) {
    throw new Error('Release metadata has an invalid versionName.')
  }
  if (!Number.isSafeInteger(metadata.versionCode) || (metadata.versionCode as number) < 1) {
    throw new Error('Release metadata has an invalid versionCode.')
  }
  if (typeof metadata.releaseNotes !== 'string' || !metadata.releaseNotes.trim()) {
    throw new Error('Release metadata has invalid release notes.')
  }
  if (typeof metadata.releaseDate !== 'string' || !Number.isFinite(Date.parse(metadata.releaseDate))) {
    throw new Error('Release metadata has an invalid releaseDate.')
  }
  if (!Number.isSafeInteger(metadata.minSupportedVersionCode)
    || (metadata.minSupportedVersionCode as number) < 1
    || (metadata.minSupportedVersionCode as number) > (metadata.versionCode as number)) {
    throw new Error('Release metadata has an invalid minimum supported version.')
  }
  if (metadata.downloadPageUrl !== RELEASE_DOWNLOAD_PAGE_URL) {
    throw new Error('Release metadata has an untrusted download page URL.')
  }

  return {
    versionName: metadata.versionName,
    versionCode: metadata.versionCode as number,
    releaseNotes: metadata.releaseNotes,
    releaseDate: metadata.releaseDate,
    minSupportedVersionCode: metadata.minSupportedVersionCode as number,
    downloadPageUrl: metadata.downloadPageUrl,
  }
}

export function isUpdateAvailable(installedVersionCode: number, release: ReleaseMetadata) {
  return Number.isSafeInteger(installedVersionCode)
    && installedVersionCode >= 1
    && release.versionCode > installedVersionCode
}

export async function fetchReleaseMetadata(fetcher: typeof fetch = fetch): Promise<ReleaseMetadata> {
  const response = await fetcher(RELEASE_METADATA_URL, { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`Release metadata request failed with HTTP ${response.status}.`)
  }
  return parseReleaseMetadata(await response.json())
}
