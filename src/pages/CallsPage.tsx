import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Phone, Search, Video } from 'lucide-react'
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'

type CallParticipant = { userId: string; status: string; muted: boolean; cameraOn: boolean; speakerOn: boolean }
type CallSession = {
  id: string
  callerId: string
  targetUserId: string | null
  type: 'voice' | 'video'
  status: string
  participants: CallParticipant[]
  provider?: string
  providerConfigured?: boolean
  createdAt: string
}
type DirectoryUser = { id: string; name: string; handle: string }
type RemoteMedia = { key: string; userId: string; track: RemoteTrack }

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

export function CallsPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const requestedCallRef = useRef('')
  const [calls, setCalls] = useState<CallSession[]>([])
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [activeCallId, setActiveCallId] = useState('')
  const [activeRoom, setActiveRoom] = useState<Room | null>(null)
  const [remoteMedia, setRemoteMedia] = useState<RemoteMedia[]>([])
  const [muted, setMuted] = useState(false)
  const [cameraOn, setCameraOn] = useState(true)
  const [needsAudioPlayback, setNeedsAudioPlayback] = useState(false)
  const [needsVideoPlayback, setNeedsVideoPlayback] = useState(false)
  const callsRef = useRef<CallSession[]>([])
  const roomRef = useRef<Room | null>(null)
  const roomCallIdRef = useRef('')
  const intentionalDisconnectRef = useRef(new WeakSet<Room>())
  const confirmedCallsRef = useRef(new Set<string>())

  const replaceCall = useCallback((call: CallSession) => {
    callsRef.current = callsRef.current.some((item) => item.id === call.id)
      ? callsRef.current.map((item) => item.id === call.id ? call : item)
      : [call, ...callsRef.current]
    setCalls(callsRef.current)
  }, [])

  const closeCallRoom = useCallback(async (callId?: string) => {
    const room = roomRef.current
    if (!room) return
    if (callId && roomCallIdRef.current !== callId) return
    intentionalDisconnectRef.current.add(room)
    roomRef.current = null
    roomCallIdRef.current = ''
    setActiveRoom(null)
    setRemoteMedia([])
    setActiveCallId('')
    setNeedsAudioPlayback(false)
    setNeedsVideoPlayback(false)
    await room.disconnect(true)
  }, [])

  const fetchCallData = useCallback(() => Promise.all([
    apiRequest<{ calls: CallSession[] }>('/api/calls/history'),
    apiRequest<{ users: DirectoryUser[] }>('/api/users'),
  ]), [])

  const applyCallData = useCallback(([history, directory]: Awaited<ReturnType<typeof fetchCallData>>) => {
    callsRef.current = history.calls
    setCalls(history.calls)
    setUsers(directory.users.filter((person) => person.id !== user?.id))
  }, [user?.id])

  const loadData = useCallback(async () => {
    try {
      applyCallData(await fetchCallData())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load calls.')
    } finally {
      setLoading(false)
    }
  }, [applyCallData, fetchCallData])

  const connectCall = useCallback(async (call: CallSession) => {
    if (roomRef.current) await closeCallRoom()
    const { token, url } = await apiRequest<{ token: string; url: string }>(`/api/calls/${encodeURIComponent(call.id)}/token`, { method: 'POST' })
    const room = new Room({ adaptiveStream: true, dynacast: true })
    roomRef.current = room
    roomCallIdRef.current = call.id
    room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => setNeedsAudioPlayback(!playing))
    room.on(RoomEvent.VideoPlaybackStatusChanged, (playing) => setNeedsVideoPlayback(!playing))
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      const key = `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
      setRemoteMedia((current) => current.some((entry) => entry.key === key)
        ? current
        : [...current, { key, userId: participant.identity, track }])
      const confirmsMedia = call.type === 'video' ? track.kind === Track.Kind.Video : track.kind === Track.Kind.Audio
      if (confirmsMedia && !confirmedCallsRef.current.has(call.id)) {
        confirmedCallsRef.current.add(call.id)
        void apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/connected`, { method: 'POST' })
          .then(({ call: updated }) => replaceCall(updated))
          .catch((connectionError) => {
            confirmedCallsRef.current.delete(call.id)
            setError(connectionError instanceof Error ? connectionError.message : 'Unable to confirm the LiveKit call connection.')
          })
      }
    })
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      const key = `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
      track.detach()
      setRemoteMedia((current) => current.filter((entry) => entry.key !== key))
    })
    room.on(RoomEvent.Reconnecting, () => setError('LiveKit connection interrupted; attempting to reconnect…'))
    room.on(RoomEvent.Reconnected, () => setError(''))
    room.on(RoomEvent.Disconnected, () => {
      if (roomRef.current !== room) return
      roomRef.current = null
      roomCallIdRef.current = ''
      setActiveRoom(null)
      setRemoteMedia([])
      setActiveCallId('')
      setNeedsAudioPlayback(false)
      setNeedsVideoPlayback(false)
      if (!intentionalDisconnectRef.current.has(room)) {
        setError('The LiveKit call disconnected.')
        void apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/leave`, { method: 'POST' })
          .then(({ call: updated }) => replaceCall(updated))
          .catch((disconnectError) => setError(disconnectError instanceof Error ? disconnectError.message : 'Unable to update the disconnected call status.'))
      }
    })

    try {
      await room.connect(url, token)
      await room.localParticipant.setMicrophoneEnabled(true)
      if (call.type === 'video') await room.localParticipant.setCameraEnabled(true)
      setMuted(false)
      setCameraOn(call.type === 'video')
      setActiveRoom(room)
      setActiveCallId(call.id)
    } catch (connectError) {
      intentionalDisconnectRef.current.add(room)
      if (roomRef.current === room) roomRef.current = null
      roomCallIdRef.current = ''
      await room.disconnect(true)
      throw connectError
    }
  }, [closeCallRoom, replaceCall])

  useEffect(() => {
    let cancelled = false
    void fetchCallData()
      .then((data) => { if (!cancelled) applyCallData(data) })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Unable to load calls.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [applyCallData, fetchCallData])

  useEffect(() => {
    const source = openAuthenticatedEventStream('/api/realtime')
    const onCallUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { call?: CallSession }
        if (!payload.call?.participants.some((participant) => participant.userId === user?.id)) return
        replaceCall(payload.call)
        if (['ended', 'cancelled', 'rejected', 'missed'].includes(payload.call.status)) {
          void closeCallRoom(payload.call.id)
        } else if (payload.call.participants.find((participant) => participant.userId === user?.id)?.status === 'left') {
          void closeCallRoom(payload.call.id)
        }
      } catch {
        setError('A call status update could not be read. Refresh call history to retry.')
      }
    }
    source.addEventListener('call:update', onCallUpdate)
    return () => source.close()
  }, [closeCallRoom, replaceCall, user?.id])

  useEffect(() => () => {
    const room = roomRef.current
    if (room) {
      intentionalDisconnectRef.current.add(room)
      const callId = roomCallIdRef.current
      roomRef.current = null
      roomCallIdRef.current = ''
      void room.disconnect(true)
      if (callId) {
        void apiRequest(`/api/calls/${encodeURIComponent(callId)}/leave`, { method: 'POST' })
          .catch((cleanupError: unknown) => console.error('Unable to leave the call while closing the calls page.', cleanupError))
      }
    }
  }, [])

  const filteredUsers = useMemo(() => users.filter((person) => `${person.name} ${person.handle}`.toLowerCase().includes(query.toLowerCase())), [users, query])

  const refreshData = () => {
    setLoading(true)
    setError('')
    void loadData()
  }

  const startCall = useCallback(async (person: DirectoryUser, type: CallSession['type']) => {
    setError('')
    setBusyId(person.id)
    let createdCall: CallSession | null = null
    try {
      const response = await apiRequest<{ call: CallSession }>('/api/calls/start', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: person.id, type }),
      })
      createdCall = response.call
      replaceCall(response.call)
      await connectCall(response.call)
    } catch (startError) {
      let cleanupError = ''
      if (createdCall) {
        await closeCallRoom(createdCall.id).catch((failure: unknown) => {
          cleanupError = failure instanceof Error ? failure.message : 'Media cleanup failed.'
        })
        try {
          await apiRequest(`/api/calls/${encodeURIComponent(createdCall.id)}/cancel`, { method: 'POST' })
        } catch (failure) {
          cleanupError = [cleanupError, failure instanceof Error ? failure.message : 'The call could not be cancelled.'].filter(Boolean).join(' ')
        }
      }
      setError([startError instanceof Error ? startError.message : 'Unable to start this call.', cleanupError].filter(Boolean).join(' '))
    } finally {
      setBusyId('')
    }
  }, [closeCallRoom, replaceCall])

  const startGroupCall = useCallback(async (conversationId: string, type: CallSession['type']) => {
    setError('')
    setBusyId(conversationId)
    let createdCall: CallSession | null = null
    try {
      const response = await apiRequest<{ call: CallSession }>('/api/calls/start', {
        method: 'POST',
        body: JSON.stringify({ conversationId, type }),
      })
      createdCall = response.call
      replaceCall(response.call)
      await connectCall(response.call)
    } catch (startError) {
      let cleanupError = ''
      if (createdCall) {
        await closeCallRoom(createdCall.id).catch((failure: unknown) => {
          cleanupError = failure instanceof Error ? failure.message : 'Media cleanup failed.'
        })
        try {
          await apiRequest(`/api/calls/${encodeURIComponent(createdCall.id)}/cancel`, { method: 'POST' })
        } catch (failure) {
          cleanupError = [cleanupError, failure instanceof Error ? failure.message : 'The call could not be cancelled.'].filter(Boolean).join(' ')
        }
      }
      setError([startError instanceof Error ? startError.message : 'Unable to start this group call.', cleanupError].filter(Boolean).join(' '))
    } finally {
      setBusyId('')
    }
  }, [closeCallRoom, connectCall, replaceCall])

  const requestedUserId = searchParams.get('user')
  const requestedConversationId = searchParams.get('conversation')
  const requestedType = searchParams.get('type')
  useEffect(() => {
    if (!requestedUserId || !['voice', 'video'].includes(requestedType ?? '') || loading) return
    const requestKey = `${requestedUserId}:${requestedType}`
    if (requestedCallRef.current === requestKey) return
    const person = users.find((candidate) => candidate.id === requestedUserId)
    if (!person) return
    requestedCallRef.current = requestKey
    void startCall(person, requestedType as CallSession['type'])
  }, [loading, requestedType, requestedUserId, startCall, users])
  useEffect(() => {
    if (!requestedConversationId || !['voice', 'video'].includes(requestedType ?? '')) return
    const requestKey = `${requestedConversationId}:${requestedType}`
    if (requestedCallRef.current === requestKey) return
    requestedCallRef.current = requestKey
    void startGroupCall(requestedConversationId, requestedType as CallSession['type'])
  }, [requestedConversationId, requestedType, startGroupCall])

  const callAction = async (call: CallSession, action: 'accept' | 'reject' | 'cancel' | 'end' | 'leave') => {
    setBusyId(call.id)
    setError('')
    try {
      const response = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/${action}`, { method: 'POST' })
      replaceCall(response.call)
      if (action === 'accept') await connectCall(response.call)
      else {
        confirmedCallsRef.current.delete(call.id)
        await closeCallRoom(call.id)
      }
    } catch (actionError) {
      if (action === 'accept') {
        setError(actionError instanceof Error ? actionError.message : 'Unable to join this call.')
        return
      }
      setError(actionError instanceof Error ? actionError.message : 'Unable to update this call.')
    } finally {
      setBusyId('')
    }
  }

  const rejoinCall = async (call: CallSession) => {
    setBusyId(call.id)
    setError('')
    try {
      await connectCall(call)
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to reconnect to this call.')
    } finally {
      setBusyId('')
    }
  }

  const toggleMute = async () => {
    const room = roomRef.current
    if (!activeCall || !room) return
    const nextMuted = !muted
    try {
      await room.localParticipant.setMicrophoneEnabled(!nextMuted)
      await apiRequest(`/api/calls/${encodeURIComponent(activeCall.id)}/mute`, { method: 'POST', body: JSON.stringify({ muted: nextMuted }) })
      setMuted(nextMuted)
    } catch (muteError) {
      try {
        await room.localParticipant.setMicrophoneEnabled(!muted)
      } catch (rollbackError) {
        setError(`${muteError instanceof Error ? muteError.message : 'Unable to update microphone state.'} Microphone rollback failed: ${rollbackError instanceof Error ? rollbackError.message : 'unknown error'}`)
        return
      }
      setError(muteError instanceof Error ? muteError.message : 'Unable to update microphone state.')
    }
  }

  const toggleCamera = async () => {
    const room = roomRef.current
    if (!activeCall || activeCall.type !== 'video' || !room) return
    const nextCameraOn = !cameraOn
    try {
      await room.localParticipant.setCameraEnabled(nextCameraOn)
      await apiRequest(`/api/calls/${encodeURIComponent(activeCall.id)}/camera`, { method: 'POST', body: JSON.stringify({ cameraOn: nextCameraOn }) })
      setCameraOn(nextCameraOn)
    } catch (cameraError) {
      try {
        await room.localParticipant.setCameraEnabled(cameraOn)
      } catch (rollbackError) {
        setError(`${cameraError instanceof Error ? cameraError.message : 'Unable to update camera state.'} Camera rollback failed: ${rollbackError instanceof Error ? rollbackError.message : 'unknown error'}`)
        return
      }
      setError(cameraError instanceof Error ? cameraError.message : 'Unable to update camera state.')
    }
  }

  const enablePlayback = async () => {
    const room = roomRef.current
    if (!room) return
    try {
      await Promise.all([room.startAudio(), room.startVideo()])
      setNeedsAudioPlayback(false)
      setNeedsVideoPlayback(false)
    } catch (playbackError) {
      setError(playbackError instanceof Error ? playbackError.message : 'Unable to start media playback.')
    }
  }

  const nameFor = (userId: string) => userId === user?.id ? 'You' : users.find((person) => person.id === userId)?.name ?? 'NOVAKOKO member'
  const activeCalls = calls.filter((call) => !['ended', 'cancelled', 'rejected', 'missed'].includes(call.status))
  const activeCall = calls.find((call) => call.id === activeCallId)
  const localVideoTrack = activeRoom?.localParticipant.getTrackPublication(Track.Source.Camera)?.track

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header><p className="text-xs font-semibold uppercase text-indigo-700">Calls</p><h2 className="mt-2 text-2xl font-semibold text-slate-900">Call history</h2></header>
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" role="status">Calls use LiveKit for encrypted, low-latency voice and video. Your administrator must configure the LiveKit media server.</div>
      {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}

      {activeCall ? <section aria-label="Active call" className="rounded-2xl border border-indigo-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-semibold text-slate-900">{activeCall.type === 'video' ? 'Video call' : 'Voice call'}</h3><p className="text-sm text-slate-600">{activeCall.status === 'connected' ? 'LiveKit media connected' : activeCall.status === 'ringing' ? 'Ringing — awaiting an answer' : 'Connecting to LiveKit…'}</p></div>
          <div className="flex gap-2">
            {needsAudioPlayback || needsVideoPlayback ? <Button variant="secondary" size="sm" onClick={() => void enablePlayback()}>Enable media playback</Button> : null}
            <Button variant="secondary" size="sm" disabled={!activeRoom} onClick={() => void toggleMute()}>{muted ? 'Unmute' : 'Mute'}</Button>
            {activeCall.type === 'video' ? <Button variant="secondary" size="sm" disabled={!activeRoom} onClick={() => void toggleCamera()}>{cameraOn ? 'Turn camera off' : 'Turn camera on'}</Button> : null}
            <Button variant="primary" size="sm" onClick={() => void callAction(activeCall, 'leave')}>Leave call</Button>
          </div>
        </div>
        {activeCall.type === 'video' ? <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div><p className="mb-1 text-xs font-medium text-slate-500">You</p>{localVideoTrack ? <AttachedTrack track={localVideoTrack} muted className="aspect-video w-full rounded-xl bg-slate-950 object-cover" /> : <div className="aspect-video w-full rounded-xl bg-slate-950" />}</div>
          {remoteMedia.filter((entry) => entry.track.kind === Track.Kind.Video).map((entry) => <div key={entry.key}><p className="mb-1 text-xs font-medium text-slate-500">{nameFor(entry.userId)}</p><AttachedTrack track={entry.track} className="aspect-video w-full rounded-xl bg-slate-950 object-cover" /></div>)}
        </div> : null}
        {remoteMedia.filter((entry) => entry.track.kind === Track.Kind.Audio).map((entry) => <AttachedTrack key={entry.key} track={entry.track} className="hidden" />)}
      </section> : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold text-slate-900">Start a call</h3>
        <label className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-500"><Search className="h-4 w-4" aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a person" aria-label="Find a person to call" className="min-w-0 flex-1 bg-transparent text-slate-800 outline-none" /></label>
        <ul className="mt-3 divide-y divide-slate-100">
          {filteredUsers.map((person) => <li key={person.id} className="flex flex-wrap items-center gap-3 py-3"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-900">{person.name}</span><span className="text-xs text-slate-500">@{person.handle}</span></span><Button variant="secondary" size="sm" disabled={Boolean(busyId) || Boolean(activeCall)} onClick={() => void startCall(person, 'voice')} icon={<Phone className="h-4 w-4" aria-hidden="true" />}>Voice</Button><Button variant="secondary" size="sm" disabled={Boolean(busyId) || Boolean(activeCall)} onClick={() => void startCall(person, 'video')} icon={<Video className="h-4 w-4" aria-hidden="true" />}>Video</Button></li>)}
          {!loading && filteredUsers.length === 0 ? <li className="py-4 text-sm text-slate-500">No people match this search.</li> : null}
        </ul>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-900">Recent and active calls</h3><Button variant="ghost" size="sm" onClick={refreshData} disabled={loading}>Refresh</Button></div>
        {loading ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500">Loading call history…</p> : null}
        {!loading && calls.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No calls yet.</p> : null}
        <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
          {calls.map((call) => {
            const own = call.participants.find((participant) => participant.userId === user?.id)
            const counterparties = call.participants.filter((participant) => participant.userId !== user?.id).map((participant) => nameFor(participant.userId)).join(', ')
            const incoming = call.callerId !== user?.id && own?.status === 'pending' && call.status === 'ringing'
            return <li key={call.id} className="flex flex-wrap items-center gap-3 p-4"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600">{call.type === 'video' ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-900">{counterparties || 'Call'}</p><p className="mt-1 text-xs text-slate-500">{call.type} · {call.status} · {new Date(call.createdAt).toLocaleString()}</p></div>{incoming ? <><Button variant="primary" size="sm" disabled={busyId === call.id || Boolean(activeCall)} onClick={() => void callAction(call, 'accept')}>Accept</Button><Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'reject')}>Decline</Button></> : null}{call.callerId === user?.id && call.status === 'ringing' ? <Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'cancel')}>Cancel</Button> : null}{own && ['accepted', 'connected'].includes(own.status) && activeCallId !== call.id ? <Button variant="primary" size="sm" disabled={Boolean(busyId) || Boolean(activeCall)} onClick={() => void rejoinCall(call)}>Join</Button> : null}{own && ['accepted', 'connected'].includes(own.status) ? <Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'leave')}>Leave</Button> : null}</li>
          })}
        </ul>
        {activeCalls.length > 0 ? <p className="mt-2 text-xs text-slate-500">A call is only marked connected after LiveKit delivers remote media to a participant.</p> : null}
      </section>
    </div>
  )
}
