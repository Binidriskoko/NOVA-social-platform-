import { useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { ANDROID_VERSION_CODE, RELEASE_METADATA_URL } from '../config/release'

type Metadata = {
  versionName: string
  versionCode: number
  releaseNotes?: string
  releaseDate?: string
  minSupportedVersionCode?: number
  downloadPageUrl?: string
}

export function UpdateChecker() {
  const [metadata, setMetadata] = useState<Metadata | null>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    let mounted = true
    const controller = new AbortController()
    // Lightweight fetch; do not block app rendering if it fails.
    fetch(RELEASE_METADATA_URL, { signal: controller.signal, cache: 'no-cache' })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error('Release metadata unavailable')))
      .then((data: Metadata) => {
        if (!mounted) return
        setMetadata(data)
        // Only show once per session and only if remote versionCode is greater.
        if (typeof data.versionCode === 'number' && data.versionCode > ANDROID_VERSION_CODE) {
          setShown(true)
        }
      })
      .catch((err) => {
        if (!mounted) return
        // Non-fatal; record to console for diagnostics.
        // Do not block the app if release metadata fetch fails.
        // eslint-disable-next-line no-console
        console.warn('UpdateChecker: failed to fetch release metadata', err)
      })
    return () => { mounted = false; controller.abort() }
  }, [])

  if (!metadata || !shown) return null

  const openDownload = () => {
    const url = metadata.downloadPageUrl ?? 'https://github.com/Binidriskoko/NOVA-social-platform-/releases/latest'
    window.open(url, '_blank', 'noopener')
  }

  return (
    <div className="mx-4 flex items-center gap-3 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-sm text-indigo-900 shadow-sm">
      <div className="flex-1">
        <div className="font-semibold">New update available — v{metadata.versionName}</div>
        <div className="mt-0.5 text-xs text-indigo-800/80">{metadata.releaseNotes ?? 'A new version is available.'}</div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" onClick={openDownload} variant="outline">Open download page</Button>
        <Button type="button" onClick={() => setShown(false)}>Dismiss</Button>
      </div>
    </div>
  )
}
