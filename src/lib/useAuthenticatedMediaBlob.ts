import { useEffect, useRef, useState } from 'react'
import { fetchMediaBlob } from './api'

type LoadedMedia = { url: string; source: string; error: string }

export function useAuthenticatedMediaBlob(url: string, enabled: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [intersectingUrl, setIntersectingUrl] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [loaded, setLoaded] = useState<LoadedMedia>({ url: '', source: '', error: '' })

  useEffect(() => {
    if (!enabled) {
      setIntersectingUrl('')
      return
    }

    const target = containerRef.current
    if (!target || typeof IntersectionObserver === 'undefined') {
      setIntersectingUrl(url)
      return
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIntersectingUrl(url)
        observer.disconnect()
      }
    }, { rootMargin: '150px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [enabled, url])

  useEffect(() => {
    if (!enabled || intersectingUrl !== url) return

    const controller = new AbortController()
    let objectUrl = ''
    void fetchMediaBlob(url, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setLoaded({ url, source: objectUrl, error: '' })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setLoaded({
          url,
          source: '',
          error: error instanceof Error ? error.message : 'Unable to load this media.',
        })
      }
    })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [enabled, intersectingUrl, retryCount, url])

  return {
    containerRef,
    source: loaded.url === url ? loaded.source : '',
    error: loaded.url === url ? loaded.error : '',
    isNearViewport: intersectingUrl === url,
    retry: () => setRetryCount((current) => current + 1),
  }
}
