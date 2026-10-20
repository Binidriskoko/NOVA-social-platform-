import { useEffect, useRef, useState } from 'react'
import { apiRequest, resolveMediaUrl } from '../lib/api'
import { isVideoPostMediaUrl } from '../lib/postMedia'
import { useAuthenticatedMediaBlob } from '../lib/useAuthenticatedMediaBlob'

type PostMediaProps = {
  url: string
  alt?: string
  className?: string
  active?: boolean
  postId?: string
  measurementSource?: 'feed' | 'videos' | 'explore' | 'profile' | 'home' | 'stories' | 'messages' | 'unknown'
}

export function PostMedia({ url, alt = 'Post attachment', className = '', active = true, postId, measurementSource = 'unknown' }: PostMediaProps) {
  const [requestedVideoUrl, setRequestedVideoUrl] = useState('')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sessionRef = useRef<{ sessionId: string; startRequest: Promise<boolean>; lastSentTime: number; lastObservedTime: number; heartbeatRequest: Promise<void> | null } | null>(null)
  const isUploaded = url.startsWith('/api/media/')
  const isVideo = isVideoPostMediaUrl(url)
  const videoRequested = requestedVideoUrl === url
  const media = useAuthenticatedMediaBlob(url, isUploaded && (!isVideo || videoRequested))

  useEffect(() => {
    const video = videoRef.current
    if (!video || active) return
    video.pause()
  }, [active])

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

  const source = isUploaded ? media.source : resolveMediaUrl(url)
  if (isUploaded && isVideo && !videoRequested) {
    return <div ref={media.containerRef} className="relative flex min-h-24 w-full items-center justify-center rounded-xl bg-slate-900">
      <button type="button" onClick={() => setRequestedVideoUrl(url)} className="rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/25">
        Load video
      </button>
    </div>
  }
  if (isUploaded && media.error) {
    return <div ref={media.containerRef} className="flex flex-col items-start gap-2">
      <p className="text-sm text-rose-700" role="alert">{media.error}</p>
      <button type="button" onClick={media.retry} className="text-sm font-semibold text-indigo-700 underline">Retry media</button>
    </div>
  }
  if (isUploaded && !source) {
    return <div ref={media.containerRef} className="flex min-h-12 w-full items-center text-sm text-slate-500" role="status">
      Media will load when it is near the screen…
    </div>
  }
  if (isVideo) {
    return <video ref={videoRef} src={source} controls playsInline preload="none" className={className} aria-label={alt} />
  }
  return <img src={source} alt={alt} loading="lazy" decoding="async" className={className} />
}
