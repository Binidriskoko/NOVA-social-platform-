import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { X } from 'lucide-react'
import { ANDROID_VERSION_CODE, UPDATE_NOTICE_STORAGE_KEY } from '../config/release'
import { fetchReleaseMetadata, isUpdateAvailable, type ReleaseMetadata } from '../lib/releaseMetadata'

let metadataRequest: Promise<ReleaseMetadata> | undefined
const noticeVersionsMarked = new Set<number>()

function hasShownNotice(versionCode: number) {
  const key = `${UPDATE_NOTICE_STORAGE_KEY}:${versionCode}`
  try {
    return noticeVersionsMarked.has(versionCode) || localStorage.getItem(key) === 'true'
  } catch {
    return noticeVersionsMarked.has(versionCode)
  }
}

function markNoticeShown(versionCode: number) {
  noticeVersionsMarked.add(versionCode)
  try {
    localStorage.setItem(`${UPDATE_NOTICE_STORAGE_KEY}:${versionCode}`, 'true')
  } catch {
    // The module-level flag still prevents repeat notices while the app is open.
  }
}

export function UpdateChecker() {
  const [release, setRelease] = useState<ReleaseMetadata | null>(null)

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return

    let active = true
    const checkForUpdates = () => {
      metadataRequest ??= fetchReleaseMetadata()
      void metadataRequest
        .then((metadata) => {
          if (active && isUpdateAvailable(ANDROID_VERSION_CODE, metadata) && !hasShownNotice(metadata.versionCode)) {
            markNoticeShown(metadata.versionCode)
            setRelease(metadata)
          }
        })
        .catch((error: unknown) => {
          metadataRequest = undefined
          if (active) console.warn('Unable to check for NOVAKOKO updates.', error)
        })
    }
    checkForUpdates()
    window.addEventListener('online', checkForUpdates)

    return () => {
      active = false
      window.removeEventListener('online', checkForUpdates)
    }
  }, [])

  if (!release) return null

  return (
    <aside
      aria-label="App update available"
      className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-3xl items-start gap-3 rounded-xl border border-indigo-200 bg-white p-4 text-sm text-indigo-950 shadow-xl"
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold">NOVAKOKO v{release.versionName} is available</p>
        <p className="mt-1 whitespace-pre-line text-indigo-800">{release.releaseNotes}</p>
        <p className="mt-2 text-xs text-slate-600">
          Android will ask you to approve installing the downloaded APK.
        </p>
      </div>
      <a
        className="shrink-0 rounded-lg bg-indigo-700 px-3 py-2 font-semibold text-white hover:bg-indigo-800"
        href={release.downloadPageUrl}
      >
        Download
      </a>
      <button
        aria-label="Dismiss update notice"
        className="rounded-md px-2 py-1 font-semibold text-slate-500 hover:bg-slate-100"
        onClick={() => setRelease(null)}
        type="button"
      >
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </aside>
  )
}
