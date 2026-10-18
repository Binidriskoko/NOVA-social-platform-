import { useEffect, useRef, useState } from 'react'
import { apiRequest, fetchMediaBlob, resolveMediaUrl } from '../lib/api'
import { isVideoPostMediaUrl } from '../lib/postMedia'

type PostMediaProps = {
  url: string
  alt?: string
  className?: string
  active?: boolean
  autoPlay?: boolean
  postId?: string
  measurementSource?: 'feed' | 'videos' | 'explore' | 'profile' | 'home' | 'stories' | 'messages' | 'unknown'
}

export function PostMedia({ url, alt = 'Post attachment', className = '', active = true, autoPlay = false, postId, measurementSource = 'unknown' }: PostMediaProps) {
  const [loaded, setLoaded] = useState<{ url: string; source: string; error: string }>({ url: '', source: '', error: '' })
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<{ sessionId: string; startRequest: Promise<boolean>; lastSentTime: number; sendingHeartbeat: boolean } | null>(null)
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

  useEffect(() => {
    const video = videoRef.current
    if (!video || !isVideo || !postId) return

    const finalizePlayback = async () => {
      const session = sessionRef.current
      if (!session) return
      sessionRef.current = null
      try {
        if (!await session.startRequest) return
        await apiRequest(`/api/monetization/video-views/finish`, {
          method: 'POST',
          body: JSON.stringify({ postId, sessionId: session.sessionId }),
        })
      } catch {
        // Playback should remain usable if the measurement service is temporarily unavailable.
      }
    }

    const handlePlay = () => {
      if (sessionRef.current) return
      const sessionId = `${postId}-${crypto.randomUUID()}`
      const session = {
        sessionId,
        lastSentTime: video.currentTime,
        sendingHeartbeat: false,
        startRequest: Promise.resolve(false),
      }
      sessionRef.current = session
      session.startRequest = apiRequest('/api/monetization/video-views/start', {
        method: 'POST',
        body: JSON.stringify({ postId, sessionId, durationSeconds: Math.max(1, Math.ceil(video.duration || 1)), source: measurementSource }),
      }).then(() => true).catch(() => false)
    }

    const heartbeat = async () => {
      const session = sessionRef.current
      if (!session || session.sendingHeartbeat || video.paused || document.visibilityState !== 'visible' || video.currentTime <= session.lastSentTime) return
      session.sendingHeartbeat = true
      try {
        if (!await session.startRequest || sessionRef.current !== session) return
        await apiRequest('/api/monetization/video-views/heartbeat', {
          method: 'POST',
          body: JSON.stringify({ postId, sessionId: session.sessionId, currentTimeSeconds: video.currentTime }),
        })
        session.lastSentTime = video.currentTime
      } catch {
        // A rejected heartbeat is not retried as credited watch time.
      } finally {
        session.sendingHeartbeat = false
      }
    }

    const handlePause = () => { void finalizePlayback() }
    const handleEnded = () => { void finalizePlayback() }
    const handleVisibility = () => {
      if (document.hidden) void finalizePlayback()
    }
    const heartbeatTimer = window.setInterval(() => { void heartbeat() }, 5_000)

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('ended', handleEnded)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.clearInterval(heartbeatTimer)
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('ended', handleEnded)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (sessionRef.current) void finalizePlayback()
    }
  }, [isVideo, measurementSource, postId, url])

  const source = isUploaded ? loaded.url === url ? loaded.source : '' : resolveMediaUrl(url)
  if (isUploaded && loaded.url !== url) return <p className="text-sm text-slate-500" role="status">Loading media…</p>
  if (isUploaded && loaded.url === url && loaded.error) return <p className="text-sm text-rose-700" role="alert">{loaded.error}</p>
  if (isVideo) {
    return <video ref={videoRef} src={source} controls muted={autoPlay} autoPlay={autoPlay && active} loop={autoPlay} playsInline preload="metadata" className={className} aria-label={alt} />
  }
  return <img src={source} alt={alt} className={className} />
}
