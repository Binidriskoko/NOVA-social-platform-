import { useEffect, useRef, useState } from 'react'
import { fetchMediaBlob, resolveMediaUrl } from '../lib/api'
import { isVideoPostMediaUrl } from '../lib/postMedia'

type PostMediaProps = {
  url: string
  alt?: string
  className?: string
  active?: boolean
  autoPlay?: boolean
}

export function PostMedia({ url, alt = 'Post attachment', className = '', active = true, autoPlay = false }: PostMediaProps) {
  const [loaded, setLoaded] = useState<{ url: string; source: string; error: string }>({ url: '', source: '', error: '' })
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const isUploaded = url.startsWith('/api/media/')
  const isVideo = isVideoPostMediaUrl(url)

  useEffect(() => {
    if (!isUploaded) return
    const controller = new AbortController()
    let objectUrl = ''
    void fetchMediaBlob(url, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setLoaded({ url, source: objectUrl, error: '' })
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) {
        setLoaded({ url, source: '', error: loadError instanceof Error ? loadError.message : 'Unable to load this media.' })
      }
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [isUploaded, url])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !autoPlay) return
    if (active) void video.play().catch(() => undefined)
    else video.pause()
  }, [active, autoPlay, loaded.source])

  const source = isUploaded ? loaded.url === url ? loaded.source : '' : resolveMediaUrl(url)
  if (isUploaded && loaded.url !== url) return <p className="text-sm text-slate-500" role="status">Loading media…</p>
  if (isUploaded && loaded.url === url && loaded.error) return <p className="text-sm text-rose-700" role="alert">{loaded.error}</p>
  if (isVideo) {
    return <video ref={videoRef} src={source} controls muted={autoPlay} autoPlay={autoPlay && active} loop={autoPlay} playsInline preload="metadata" className={className} aria-label={alt} />
  }
  return <img src={source} alt={alt} className={className} />
}
