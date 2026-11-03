import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { apiRequest, fetchMediaBlob, resolveMediaUrl } from '../lib/api'
import { isVideoPostMediaUrl } from '../lib/postMedia'

type PostMediaProps = {
  url: string
  alt?: string
  className?: string
  active?: boolean
  autoPlay?: boolean
  muted?: boolean
  onMutedChange?: (muted: boolean) => void
  postId?: string
  measurementSource?: 'feed' | 'videos' | 'explore' | 'profile' | 'home' | 'stories' | 'messages' | 'unknown'
}

export function PostMedia({ url, alt = 'Post attachment', className = '', active = true, autoPlay = false, muted, onMutedChange, postId, measurementSource = 'unknown' }: PostMediaProps) {
  const [loaded, setLoaded] = useState<{ url: string; source: string; error: string }>({ url: '', source: '', error: '' })
  const [playbackError, setPlaybackError] = useState('')
  const [playbackLoading, setPlaybackLoading] = useState(true)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [internalMuted, setInternalMuted] = useState(autoPlay)
  const [autoplayMuted, setAutoplayMuted] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const [loadTarget, setLoadTarget] = useState<HTMLElement | null>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const retryAttemptsRef = useRef(0)
  const retryTimerRef = useRef<number | null>(null)
  const savedPlaybackTimeRef = useRef(0)
  const sessionRef = useRef<{ sessionId: string; startRequest: Promise<boolean>; lastSentTime: number; lastObservedTime: number; heartbeatRequest: Promise<void> | null } | null>(null)
  const isUploaded = url.startsWith('/api/media/')
  const isVideo = isVideoPostMediaUrl(url)
  const streamsUploadedVideo = isVideo && url.startsWith('/api/media/files/')
  const preferredMuted = muted ?? internalMuted
  const currentMuted = preferredMuted || autoplayMuted

  const updateMuted = (nextMuted: boolean, video?: HTMLVideoElement) => {
    if (video) {
      video.muted = nextMuted
      if (!nextMuted && video.volume === 0) video.volume = 1
    }
    if (muted === undefined) setInternalMuted(nextMuted)
    setAutoplayMuted(false)
    onMutedChange?.(nextMuted)
  }
  const setVideoRef = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video
    if (video) video.defaultMuted = autoPlay && preferredMuted
  }, [autoPlay, preferredMuted])

  useEffect(() => {
    if (!isUploaded || streamsUploadedVideo || nearViewport || !loadTarget) return
    if (!('IntersectionObserver' in window)) {
      setNearViewport(true)
      return
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true)
        observer.disconnect()
      }
    }, { rootMargin: '300px' })
    observer.observe(loadTarget)
    return () => observer.disconnect()
  }, [isUploaded, loadTarget, nearViewport, streamsUploadedVideo])

  useEffect(() => {
    if (!isUploaded || streamsUploadedVideo || !nearViewport) return
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
  }, [isUploaded, nearViewport, retryCount, streamsUploadedVideo, url])

  useEffect(() => {
    setPlaybackError('')
    setPlaybackLoading(true)
    setAutoplayBlocked(false)
    setAutoplayMuted(false)
    retryAttemptsRef.current = 0
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
    return () => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [autoPlay, url])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !autoPlay) return
    if (active) {
      void video.play().catch(() => {
        setAutoplayBlocked(true)
        if (!video.muted) {
          video.muted = true
          setAutoplayMuted(true)
        }
      })
    } else {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [active, autoPlay, loaded.source, retryCount, currentMuted])

  useEffect(() => {
    if (active || retryTimerRef.current === null) return
    window.clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
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

    let heartbeatTimer: number | undefined
    const clearHeartbeat = () => {
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
      }
    }

    const finalizePlayback = async () => {
      clearHeartbeat()
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
      heartbeatTimer = window.setInterval(() => { void sendHeartbeat(session) }, 5_000)
      session.startRequest = apiRequest('/api/monetization/video-views/start', {
        method: 'POST',
        body: JSON.stringify({ postId, sessionId, durationSeconds: Math.max(1, Math.ceil(video.duration)), startPositionSeconds: video.currentTime, source: measurementSource }),
      }).then(() => true).catch((error: unknown) => {
        console.warn('Video playback measurement session could not be started.', error)
        return false
      })
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

    video.addEventListener('play', handlePlay)
    video.addEventListener('loadedmetadata', handlePlay)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('pause', handlePause)
    video.addEventListener('ended', handleEnded)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      clearHeartbeat()
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('loadedmetadata', handlePlay)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('ended', handleEnded)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (sessionRef.current) void finalizePlayback()
    }
  }, [isVideo, measurementSource, postId, retryCount, url])

  const source = streamsUploadedVideo
    ? resolveMediaUrl(url)
    : isUploaded ? loaded.url === url ? loaded.source : '' : resolveMediaUrl(url)
  const videoSource = autoPlay && !active ? '' : source
  const scheduleRetry = () => {
    setPlaybackLoading(false)
    setPlaybackError('This video could not be played. Check your connection and retry.')
    if (!autoPlay || !active || retryAttemptsRef.current >= 2) return
    retryAttemptsRef.current += 1
    const delay = 750 * 2 ** (retryAttemptsRef.current - 1)
    setPlaybackError('Connection interrupted. Retrying…')
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null
      setPlaybackError('')
      setPlaybackLoading(true)
      setRetryCount((count) => count + 1)
    }, delay)
  }
  if (isUploaded && !streamsUploadedVideo && loaded.url !== url) return <div ref={setLoadTarget}>
    <p className="text-sm text-slate-500" role="status">{nearViewport ? 'Loading media…' : 'Media will load when near the screen…'}</p>
  </div>
  if (isUploaded && !streamsUploadedVideo && loaded.url === url && loaded.error) return <div ref={setLoadTarget}>
    <p className="text-sm text-rose-700" role="alert">{loaded.error}</p>
    <button type="button" className="mt-1 text-sm font-semibold underline" onClick={() => {
      setLoaded({ url: '', source: '', error: '' })
      setRetryCount((count) => count + 1)
    }}>Retry media</button>
  </div>
  if (isVideo) {
    return (
      <div className="relative">
        <video
          key={`${url}-${retryCount}`}
          ref={setVideoRef}
          src={videoSource || undefined}
          crossOrigin={streamsUploadedVideo ? 'use-credentials' : undefined}
          controls
          muted={currentMuted}
          autoPlay={autoPlay && active}
          loop={autoPlay}
          playsInline
          preload={active ? 'metadata' : 'none'}
          className={className}
          aria-label={alt}
          onClick={(event) => {
            const video = event.currentTarget
            const clickedNativeControls = video.controls && video.clientHeight > 48
              && event.nativeEvent.offsetY >= video.clientHeight - 48
            if (!autoPlay || !video.muted || clickedNativeControls) return
            updateMuted(false, video)
            if (video.paused) {
              void video.play().catch(() => setAutoplayBlocked(true))
            }
          }}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget
            if (savedPlaybackTimeRef.current > 0 && savedPlaybackTimeRef.current < video.duration) {
              video.currentTime = savedPlaybackTimeRef.current
            }
          }}
          onLoadedData={() => { setPlaybackLoading(false); setPlaybackError('') }}
          onPlaying={() => {
            setPlaybackLoading(false)
            setPlaybackError('')
            setAutoplayBlocked(false)
            if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
            retryTimerRef.current = null
            retryAttemptsRef.current = 0
            savedPlaybackTimeRef.current = 0
          }}
          onWaiting={() => setPlaybackLoading(true)}
          onCanPlay={() => setPlaybackLoading(false)}
          onVolumeChange={(event) => {
            const video = event.currentTarget
            const nextMuted = video.muted || video.volume === 0
            if (nextMuted !== currentMuted) updateMuted(nextMuted, video)
          }}
          onError={() => {
            if (videoRef.current && Number.isFinite(videoRef.current.currentTime)) {
              savedPlaybackTimeRef.current = videoRef.current.currentTime
            }
            scheduleRetry()
          }}
        />
        {autoPlay ? (
          <button
            type="button"
            className="absolute right-3 top-3 z-10 rounded-full bg-black/65 p-2 text-white"
            aria-label={currentMuted ? 'Turn video sound on' : 'Turn video sound off'}
            aria-pressed={!currentMuted}
            onClick={(event) => {
              event.stopPropagation()
              const video = videoRef.current
              updateMuted(!currentMuted, video ?? undefined)
              if (video?.paused && active) {
                void video.play().catch(() => setAutoplayBlocked(true))
              }
            }}
          >
            {currentMuted ? <VolumeX className="h-5 w-5" aria-hidden="true" /> : <Volume2 className="h-5 w-5" aria-hidden="true" />}
          </button>
        ) : null}
        {playbackLoading && autoPlay && active && !playbackError ? <p className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-white" role="status">Loading video…</p> : null}
        {autoplayBlocked && !playbackError ? <p className="absolute bottom-12 left-3 rounded bg-black/70 px-2 py-1 text-xs text-white" role="status">Playback did not start automatically. Press play to start.</p> : null}
        {playbackError ? (
          <div className="absolute inset-x-3 bottom-12 flex items-center justify-between gap-3 rounded bg-black/85 p-3 text-sm text-white" role="alert">
            <span>{playbackError}</span>
            <button type="button" className="shrink-0 underline" onClick={() => {
              setPlaybackError('')
              setPlaybackLoading(true)
              setAutoplayBlocked(false)
              setRetryCount((count) => count + 1)
            }}>Retry</button>
          </div>
        ) : null}
      </div>
    )
  }
  return <img src={source} alt={alt} loading="lazy" decoding="async" className={className} />
}
