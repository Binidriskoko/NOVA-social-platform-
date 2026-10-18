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
  const sessionRef = useRef<{ sessionId: string; startRequest: Promise<boolean>; lastSentTime: number; lastObservedTime: number; heartbeatRequest: Promise<void> | null } | null>(null)
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

    const sendHeartbeat = async (session: NonNullable<typeof sessionRef.current>, final = false) => {
      if (session.heartbeatRequest) await session.heartbeatRequest
      if (!final && (sessionRef.current !== session || video.paused || document.visibilityState !== 'visible')) return
      const request = (async () => {
        if (!await session.startRequest || (!final && sessionRef.current !== session)) return
        const currentTimeSeconds = final ? session.lastObservedTime : video.currentTime
        if (currentTimeSeconds <= session.lastSentTime) return
        await apiRequest('/api/monetization/video-views/heartbeat', {
          method: 'POST',
          body: JSON.stringify({ postId, sessionId: session.sessionId, currentTimeSeconds }),
        })
        session.lastSentTime = currentTimeSeconds
        session.lastObservedTime = currentTimeSeconds
      })().catch((error: unknown) => {
        console.warn('Video playback heartbeat was not recorded.', error)
      })
      session.heartbeatRequest = request
      try {
        await request
      } finally {
        if (session.heartbeatRequest === request) session.heartbeatRequest = null
      }
    }

    const finalizePlayback = async () => {
      const session = sessionRef.current
      if (!session) return
      sessionRef.current = null
      try {
        if (!await session.startRequest) return
        await sendHeartbeat(session, true)
        await apiRequest(`/api/monetization/video-views/finish`, {
          method: 'POST',
          body: JSON.stringify({ postId, sessionId: session.sessionId }),
        })
      } catch (error) {
        console.warn('Video playback measurement could not be finalized.', error)
      }
    }

    const handlePlay = () => {
      if (sessionRef.current || video.paused) return
      if (!Number.isFinite(video.duration) || video.duration <= 0) return
      const sessionId = `${postId}-${crypto.randomUUID()}`
      const session = {
        sessionId,
        lastSentTime: video.currentTime,
        lastObservedTime: video.currentTime,
        heartbeatRequest: null as Promise<void> | null,
        startRequest: Promise.resolve(false),
      }
      sessionRef.current = session
      session.startRequest = apiRequest('/api/monetization/video-views/start', {
        method: 'POST',
        body: JSON.stringify({ postId, sessionId, durationSeconds: Math.max(1, Math.ceil(video.duration)), startPositionSeconds: video.currentTime, source: measurementSource }),
      }).then(() => true).catch((error: unknown) => {
        console.warn('Video playback measurement session could not be started.', error)
        return false
      })
    }

    const heartbeat = async () => {
      const session = sessionRef.current
      if (session) await sendHeartbeat(session)
    }

    const handleTimeUpdate = () => {
      const session = sessionRef.current
      if (session && !video.paused && document.visibilityState === 'visible') session.lastObservedTime = video.currentTime
    }
    const finalizeAtCurrentPosition = () => {
      if (sessionRef.current) sessionRef.current.lastObservedTime = video.currentTime
      void finalizePlayback()
    }
    const handlePause = () => { finalizeAtCurrentPosition() }
    const handleEnded = () => { finalizeAtCurrentPosition() }
    const handleVisibility = () => {
      if (document.hidden) finalizeAtCurrentPosition()
      else if (!video.paused) handlePlay()
    }
    const heartbeatTimer = window.setInterval(() => { void heartbeat() }, 5_000)

    video.addEventListener('play', handlePlay)
    video.addEventListener('loadedmetadata', handlePlay)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('pause', handlePause)
    video.addEventListener('ended', handleEnded)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.clearInterval(heartbeatTimer)
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('loadedmetadata', handlePlay)
      video.removeEventListener('timeupdate', handleTimeUpdate)
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
