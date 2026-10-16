import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Headphones, Radio, RefreshCw, Users } from 'lucide-react'
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'
import { cameraSwitchErrorMessage, switchToNextCamera } from '../lib/cameraSwitching'

type LiveComment = { id: string; userId: string; text: string; createdAt: string }
type LiveSession = {
  id: string
  hostId: string
  title: string
  description?: string | null
  visibility: string
  status: string
  viewerCount: number
  provider?: string
  providerConfigured: boolean
  comments: LiveComment[]
}

function AttachedTrack({ track, muted = false, className }: { track: Track; muted?: boolean; className: string }) {
  const elementRef = useRef<HTMLMediaElement | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    track.attach(element)
    return () => { track.detach(element) }
  }, [track])

  if (track.kind === Track.Kind.Video) {
    return <video ref={(element) => { elementRef.current = element }} autoPlay muted={muted} playsInline className={className} />
  }
  return <audio ref={(element) => { elementRef.current = element }} autoPlay className={className} />
}

export function LivePage() {
  const { user } = useAuth()
  const [lives, setLives] = useState<LiveSession[]>([])
  const [joinedLive, setJoinedLive] = useState<LiveSession | null>(null)
  const [comment, setComment] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [hostRoom, setHostRoom] = useState<Room | null>(null)
  const [remoteTracks, setRemoteTracks] = useState<Array<{ key: string; track: RemoteTrack }>>([])
  const [hostMuted, setHostMuted] = useState(false)
  const [hostCameraOn, setHostCameraOn] = useState(true)
  const [cameraSwitchBusy, setCameraSwitchBusy] = useState(false)
  const [needsAudioPlayback, setNeedsAudioPlayback] = useState(false)
  const [needsVideoPlayback, setNeedsVideoPlayback] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const roomRef = useRef<Room | null>(null)
  const hostRoomRef = useRef<Room | null>(null)
  const joinedLiveRef = useRef<LiveSession | null>(null)
  const livesRef = useRef<LiveSession[]>([])
  const intentionalDisconnectRef = useRef(new WeakSet<Room>())

  const setLiveState = useCallback((live: LiveSession) => {
    livesRef.current = livesRef.current.some((entry) => entry.id === live.id)
      ? livesRef.current.map((entry) => entry.id === live.id ? live : entry)
      : [live, ...livesRef.current]
    setLives(livesRef.current)
    if (joinedLiveRef.current?.id === live.id) {
      joinedLiveRef.current = live
      setJoinedLive(live)
    }
  }, [])

  const clearRoom = useCallback(async (room: Room) => {
    intentionalDisconnectRef.current.add(room)
    if (roomRef.current === room) roomRef.current = null
    if (hostRoomRef.current === room) hostRoomRef.current = null
    setHostRoom((current) => current === room ? null : current)
    setRemoteTracks([])
    setNeedsAudioPlayback(false)
    setNeedsVideoPlayback(false)
    await room.disconnect(true)
  }, [])

  const fetchLives = useCallback(() => apiRequest<{ lives: LiveSession[] }>('/api/live'), [])

  const applyLives = useCallback((lives: LiveSession[]) => {
    livesRef.current = lives
    setLives(lives)
    if (joinedLiveRef.current) {
      const refreshed = lives.find((live) => live.id === joinedLiveRef.current?.id) ?? null
      joinedLiveRef.current = refreshed
      setJoinedLive(refreshed)
    }
  }, [])

  const loadLives = useCallback(async () => {
    try {
      const response = await fetchLives()
      applyLives(response.lives)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load live sessions.')
    } finally {
      setLoading(false)
    }
  }, [applyLives, fetchLives])

  const refreshLives = () => {
    setLoading(true)
    setError('')
    void loadLives()
  }

  useEffect(() => {
    let cancelled = false
    void fetchLives()
      .then(({ lives: currentLives }) => { if (!cancelled) applyLives(currentLives) })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Unable to load live sessions.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [applyLives, fetchLives])

  useEffect(() => {
    const source = openAuthenticatedEventStream('/api/realtime')
    const onLiveUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { live?: LiveSession }
        if (!payload.live) return
        setLiveState(payload.live)
        if (payload.live.status === 'ended') {
          const room = roomRef.current
          if (room && (payload.live.hostId === user?.id || joinedLiveRef.current?.id === payload.live.id)) {
            void clearRoom(room)
            joinedLiveRef.current = null
            setJoinedLive(null)
          }
        }
      } catch {
        setError('A live session update could not be read. Refresh to retry.')
      }
    }
    source.addEventListener('live:update', onLiveUpdate)
    return () => source.close()
  }, [clearRoom, setLiveState, user?.id])

  useEffect(() => () => {
    const room = roomRef.current
    if (room) {
      intentionalDisconnectRef.current.add(room)
      const hostLive = hostRoomRef.current === room
        ? livesRef.current.find((live) => live.hostId === user?.id && live.status === 'live')
        : null
      const viewerLive = !hostLive && joinedLiveRef.current?.id
        ? joinedLiveRef.current
        : null
      roomRef.current = null
      hostRoomRef.current = null
      void room.disconnect(true)
      const cleanupPath = hostLive
        ? `/api/live/${encodeURIComponent(hostLive.id)}/end`
        : viewerLive
          ? `/api/live/${encodeURIComponent(viewerLive.id)}/viewers/leave`
          : null
      if (cleanupPath) {
        void apiRequest(cleanupPath, { method: 'POST' })
          .catch((cleanupError: unknown) => console.error('Unable to close live media while leaving the live page.', cleanupError))
      }
    }
  }, [user?.id])

  const createLive = async (event: FormEvent) => {
    event.preventDefault()
    if (!newTitle.trim()) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>('/api/live/create', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle.trim(), description: newDescription.trim() }),
      })
      setLiveState(response.live)
      setNewTitle('')
      setNewDescription('')
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create a live session.')
    } finally {
      setBusy(false)
    }
  }

  const startBroadcast = async (live: LiveSession) => {
    setBusy(true)
    setError('')
    let room: Room | null = null
    try {
      const { token, url } = await apiRequest<{ token: string; url: string }>(`/api/live/${encodeURIComponent(live.id)}/token`, { method: 'POST' })
      room = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = room
      hostRoomRef.current = room
      room.on(RoomEvent.Reconnecting, () => setError('LiveKit connection interrupted; attempting to reconnect…'))
      room.on(RoomEvent.Reconnected, () => setError(''))
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return
        roomRef.current = null
        hostRoomRef.current = null
        setHostRoom(null)
        if (!intentionalDisconnectRef.current.has(room!)) {
          setError('The LiveKit broadcast disconnected.')
          if (livesRef.current.find((entry) => entry.id === live.id)?.status === 'live') {
            void apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/end`, { method: 'POST' })
              .then(({ live: ended }) => setLiveState(ended))
              .catch((disconnectError) => setError(disconnectError instanceof Error ? disconnectError.message : 'Unable to close the disconnected broadcast.'))
          }
        }
      })
      await room.connect(url, token)
      await room.localParticipant.setMicrophoneEnabled(true)
      await room.localParticipant.setCameraEnabled(true, { resolution: { width: 1280, height: 720 } })
      if (!room.localParticipant.getTrackPublication(Track.Source.Camera)?.track || !room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track) {
        throw new Error('LiveKit did not publish the camera and microphone. The broadcast has not started.')
      }
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/start`, { method: 'POST' })
      setLiveState(response.live)
      setHostRoom(room)
      setHostMuted(false)
      setHostCameraOn(true)
    } catch (startError) {
      let cleanupError = ''
      if (room) {
        try {
          await clearRoom(room)
        } catch (failure) {
          cleanupError = failure instanceof Error ? failure.message : 'Media cleanup failed.'
        }
      }
      setError([startError instanceof Error ? startError.message : 'Unable to start the live broadcast.', cleanupError].filter(Boolean).join(' '))
    } finally {
      setBusy(false)
    }
  }

  const endBroadcast = async (live: LiveSession) => {
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/end`, { method: 'POST' })
      setLiveState(response.live)
      if (hostRoomRef.current) await clearRoom(hostRoomRef.current)
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : 'Unable to end this live session.')
    } finally {
      setBusy(false)
    }
  }

  const toggleHostMute = async () => {
    const room = hostRoomRef.current
    if (!room) return
    const nextMuted = !hostMuted
    try {
      await room.localParticipant.setMicrophoneEnabled(!nextMuted)
      setHostMuted(nextMuted)
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : 'Unable to update microphone state.')
    }
  }

  const toggleHostCamera = async () => {
    const room = hostRoomRef.current
    if (!room) return
    const nextCameraOn = !hostCameraOn
    try {
      await room.localParticipant.setCameraEnabled(nextCameraOn)
      setHostCameraOn(nextCameraOn)
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : 'Unable to update camera state.')
    }
  }

  const switchHostCamera = async () => {
    const room = hostRoomRef.current
    if (!room || !hostCameraOn || cameraSwitchBusy) return
    setCameraSwitchBusy(true)
    setError('')
    try {
      const cameraTrack = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track
      if (!cameraTrack) throw new Error('Your camera is not active. Turn it on before switching cameras.')
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('This browser does not support camera device selection.')
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput')
      const settings = cameraTrack.mediaStreamTrack.getSettings()
      await switchToNextCamera(devices, room.getActiveDevice('videoinput') ?? settings.deviceId, settings.facingMode, (deviceId) =>
        room.switchActiveDevice('videoinput', deviceId, true))
    } catch (switchError) {
      setError(cameraSwitchErrorMessage(switchError))
    } finally {
      setCameraSwitchBusy(false)
    }
  }

  const joinLive = async (live: LiveSession) => {
    setBusy(true)
    setError('')
    let room: Room | null = null
    let viewerJoined = false
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/viewers/join`, { method: 'POST' })
      viewerJoined = true
      joinedLiveRef.current = response.live
      setJoinedLive(response.live)
      setLiveState(response.live)
      const { token, url } = await apiRequest<{ token: string; url: string }>(`/api/live/${encodeURIComponent(live.id)}/token`, { method: 'POST' })
      room = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = room
      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        const key = `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
        setRemoteTracks((current) => current.some((entry) => entry.key === key) ? current : [...current, { key, track }])
      })
      room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        const key = `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
        track.detach()
        setRemoteTracks((current) => current.filter((entry) => entry.key !== key))
      })
      room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => setNeedsAudioPlayback(!playing))
      room.on(RoomEvent.VideoPlaybackStatusChanged, (playing) => setNeedsVideoPlayback(!playing))
      room.on(RoomEvent.Reconnecting, () => setError('LiveKit connection interrupted; attempting to reconnect…'))
      room.on(RoomEvent.Reconnected, () => setError(''))
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return
        roomRef.current = null
        setRemoteTracks([])
        if (!intentionalDisconnectRef.current.has(room!)) {
          setNeedsAudioPlayback(false)
          setNeedsVideoPlayback(false)
          joinedLiveRef.current = null
          setJoinedLive(null)
          setError('The live session disconnected.')
          void apiRequest(`/api/live/${encodeURIComponent(live.id)}/viewers/leave`, { method: 'POST' })
            .catch((leaveError) => setError(leaveError instanceof Error ? leaveError.message : 'Unable to update live viewer status.'))
        }
      })
      await room.connect(url, token)
    } catch (joinError) {
      let cleanupError = ''
      if (room) {
        try {
          await clearRoom(room)
        } catch (failure) {
          cleanupError = failure instanceof Error ? failure.message : 'Media cleanup failed.'
        }
      }
      if (viewerJoined) {
        try {
          await apiRequest(`/api/live/${encodeURIComponent(live.id)}/viewers/leave`, { method: 'POST' })
        } catch (failure) {
          cleanupError = [cleanupError, failure instanceof Error ? failure.message : 'Viewer membership cleanup failed.'].filter(Boolean).join(' ')
        }
        joinedLiveRef.current = null
        setJoinedLive(null)
      }
      setError([joinError instanceof Error ? joinError.message : 'Unable to join this live session.', cleanupError].filter(Boolean).join(' '))
    } finally {
      setBusy(false)
    }
  }

  const leaveLive = async () => {
    const currentLive = joinedLiveRef.current
    if (!currentLive) return
    setBusy(true)
    setError('')
    try {
      if (roomRef.current) await clearRoom(roomRef.current)
      await apiRequest(`/api/live/${encodeURIComponent(currentLive.id)}/viewers/leave`, { method: 'POST' })
      joinedLiveRef.current = null
      setJoinedLive(null)
      await loadLives()
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : 'Unable to leave this session.')
    } finally {
      setBusy(false)
    }
  }

  const enablePlayback = async () => {
    const room = roomRef.current
    if (!room) return
    try {
      await room.startAudio()
      setNeedsAudioPlayback(false)
      await room.startVideo()
      setNeedsVideoPlayback(false)
    } catch (playbackError) {
      setError(playbackError instanceof Error ? playbackError.message : 'Unable to start media playback.')
    }
  }

  const postComment = async (event: FormEvent) => {
    event.preventDefault()
    if (!joinedLive || !comment.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ comment: LiveComment }>(`/api/live/${encodeURIComponent(joinedLive.id)}/comment`, { method: 'POST', body: JSON.stringify({ text: comment.trim() }) })
      setJoinedLive((current) => current ? { ...current, comments: [...current.comments, response.comment] } : current)
      setComment('')
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to post your comment.')
    } finally {
      setBusy(false)
    }
  }

  const react = async (live: LiveSession) => {
    try {
      await apiRequest(`/api/live/${encodeURIComponent(live.id)}/react`, { method: 'POST', body: JSON.stringify({ type: 'LIKE' }) })
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Unable to react to this session.')
    }
  }

  const hostLive = lives.find((live) => live.hostId === user?.id && live.status === 'live')
  const localVideoTrack = hostRoom?.localParticipant.getTrackPublication(Track.Source.Camera)?.track
  const remoteVideoTracks = remoteTracks.filter(({ track }) => track.kind === Track.Kind.Video)
  const remoteAudioTracks = remoteTracks.filter(({ track }) => track.kind === Track.Kind.Audio)

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase text-indigo-700"><Radio className="h-4 w-4" aria-hidden="true" /> Live</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900">Live sessions</h2>
      </header>

      <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900" role="status">Live broadcasts use LiveKit for encrypted, low-latency audio and video. Your administrator must configure the LiveKit media server.</div>
      {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p> : null}

      <form onSubmit={(event) => void createLive(event)} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold text-slate-900">Create a live session</h3>
        <input aria-label="Live session title" required maxLength={120} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="What are you going live about?" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <textarea aria-label="Live session description" maxLength={1000} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Add a description (optional)" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <div className="flex justify-end"><Button type="submit" variant="primary" size="sm" disabled={busy || !newTitle.trim()}>Create session</Button></div>
      </form>

      {hostLive && hostRoom ? <section className="rounded-2xl border border-indigo-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-slate-900">Your live broadcast</h3><p className="text-sm text-slate-600">{hostLive.title}</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" onClick={() => void toggleHostMute()}>{hostMuted ? 'Unmute' : 'Mute'}</Button><Button variant="secondary" size="sm" onClick={() => void toggleHostCamera()}>{hostCameraOn ? 'Turn camera off' : 'Turn camera on'}</Button>{hostCameraOn ? <Button variant="secondary" size="sm" onClick={() => void switchHostCamera()} disabled={cameraSwitchBusy} icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}>{cameraSwitchBusy ? 'Switching…' : 'Switch camera'}</Button> : null}<Button variant="secondary" size="sm" onClick={() => void endBroadcast(hostLive)} disabled={busy}>End broadcast</Button></div></div>
        {localVideoTrack ? <AttachedTrack track={localVideoTrack} muted className="mt-3 aspect-video w-full rounded-xl bg-slate-950 object-cover" /> : <div className="mt-3 aspect-video w-full rounded-xl bg-slate-950" />}
      </section> : null}

      {joinedLive ? (
        <section className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="font-semibold text-slate-900">{joinedLive.title}</h3><p className="text-sm text-slate-600">{remoteTracks.length ? 'LiveKit media connected.' : 'Connecting to the live broadcast…'}</p></div>
            <div className="flex gap-2">{needsAudioPlayback || needsVideoPlayback ? <Button variant="secondary" size="sm" onClick={() => void enablePlayback()}>Enable media playback</Button> : null}<Button variant="secondary" size="sm" onClick={() => void leaveLive()} disabled={busy}>Leave session</Button></div>
          </div>
          {remoteVideoTracks.map(({ key, track }) => <AttachedTrack key={key} track={track} className="mt-3 aspect-video w-full rounded-xl bg-slate-950 object-contain" />)}
          {remoteAudioTracks.map(({ key, track }) => <AttachedTrack key={key} track={track} className="hidden" />)}
          <>
            <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto">{joinedLive.comments.map((entry) => <li key={entry.id} className="rounded-xl bg-white p-2 text-sm text-slate-700">{entry.text}</li>)}</ul>
            <form onSubmit={(event) => void postComment(event)} className="mt-3 flex gap-2"><input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={500} aria-label="Live comment" placeholder="Write a comment" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /><Button type="submit" variant="primary" size="sm" disabled={busy || !comment.trim()}>Send</Button></form>
          </>
        </section>
      ) : null}

      {loading ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500">Loading sessions…</p> : null}
      {!loading && lives.length === 0 && !error ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No live sessions are available.</p> : null}
      <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
        {lives.map((live) => (
          <li key={live.id} className="flex flex-wrap items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700"><Headphones className="h-5 w-5" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1"><h3 className="truncate font-semibold text-slate-900">{live.title}</h3><p className="mt-1 text-sm text-slate-500">{live.description || `Hosted by ${live.hostId === user?.id ? 'you' : 'a NOVAKOKO member'}`} · {live.viewerCount} listeners · {live.status}</p></div>
            {live.hostId === user?.id && live.status === 'paused' ? <Button variant="primary" size="sm" onClick={() => void startBroadcast(live)} disabled={busy}>Start broadcasting</Button> : null}
            {live.hostId !== user?.id && live.status === 'live' && joinedLive?.id !== live.id ? <><Button variant="secondary" size="sm" onClick={() => void react(live)}>React</Button><Button variant="primary" size="sm" onClick={() => void joinLive(live)} disabled={busy}>Join live</Button></> : null}
          </li>
        ))}
      </ul>

      <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={refreshLives} disabled={loading}><Users className="h-4 w-4" aria-hidden="true" /> Refresh</Button></div>
    </div>
  )
}
