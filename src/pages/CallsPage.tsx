import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Mic, MicOff, Phone, PhoneOff, RefreshCw, Search, Video, VideoOff, Volume2 } from 'lucide-react'
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest, resolveMediaUrl } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'
import { callScreenState, callViewportClassName, formatCallDuration } from '../lib/callPresentation'
import { cameraSwitchErrorMessage, switchToNextCamera } from '../lib/cameraSwitching'

type CallParticipant = { userId: string; status: string; muted: boolean; cameraOn: boolean; speakerOn: boolean }
type CallSession = {
  id: string
  callerId: string
  targetUserId: string | null
  type: 'voice' | 'video'
  status: string
  participants: CallParticipant[]
  conversationId?: string | null
  connectedAt?: string | null
  provider?: string
  providerConfigured?: boolean
  createdAt: string
}
type DirectoryUser = { id: string; name: string; handle: string; avatar?: string }
type CallConversation = {
  id: string
  name: string | null
  imageUrl?: string | null
  isGroup?: boolean
  participants: { userId: string; user?: { name: string; avatar?: string } }[]
}
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
  const [conversations, setConversations] = useState<CallConversation[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [activeCallId, setActiveCallId] = useState('')
  const [callScreenId, setCallScreenId] = useState('')
  const [callFailure, setCallFailure] = useState('')
  const [activeRoom, setActiveRoom] = useState<Room | null>(null)
  const [remoteMedia, setRemoteMedia] = useState<RemoteMedia[]>([])
  const [muted, setMuted] = useState(false)
  const [cameraOn, setCameraOn] = useState(true)
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])
  const [audioOutputId, setAudioOutputId] = useState('')
  const [cameraSwitchBusy, setCameraSwitchBusy] = useState(false)
  const [callClock, setCallClock] = useState(0)
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
    apiRequest<{ conversations: CallConversation[] }>('/api/conversations'),
  ]), [])

  const applyCallData = useCallback(([history, directory, conversationList]: Awaited<ReturnType<typeof fetchCallData>>) => {
    callsRef.current = history.calls
    setCalls(history.calls)
    setUsers(directory.users.filter((person) => person.id !== user?.id))
    setConversations(conversationList.conversations)
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
      setAudioOutputs([])
      setAudioOutputId('')
      if (!intentionalDisconnectRef.current.has(room)) {
        setCallFailure('The LiveKit call disconnected.')
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
      setCallScreenId(call.id)
      setCallFailure('')
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
    if (!activeRoom) return
    let cancelled = false
    if (!navigator.mediaDevices?.enumerateDevices) {
      return
    }
    void navigator.mediaDevices.enumerateDevices()
      .then((devices) => {
        if (!cancelled) {
          const outputs = devices.filter((device) => device.kind === 'audiooutput')
          setAudioOutputs(outputs)
          setAudioOutputId(activeRoom.getActiveDevice('audiooutput') ?? outputs[0]?.deviceId ?? '')
        }
      })
      .catch((deviceError: unknown) => {
        if (!cancelled) setError(deviceError instanceof Error ? `Unable to list audio output devices: ${deviceError.message}` : 'Unable to list audio output devices.')
      })
    return () => { cancelled = true }
  }, [activeRoom])

  useEffect(() => {
    const timer = window.setInterval(() => setCallClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

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
      const call = callsRef.current.find((entry) => entry.id === callId)
      roomRef.current = null
      roomCallIdRef.current = ''
      void room.disconnect(true)
      if (callId) {
        const action = call && call.callerId === user?.id && call.status === 'ringing' ? 'cancel' : 'leave'
        void apiRequest(`/api/calls/${encodeURIComponent(callId)}/${action}`, { method: 'POST' })
          .catch((cleanupError: unknown) => console.error('Unable to leave the call while closing the calls page.', cleanupError))
      }
    }
  }, [user?.id])

  const filteredUsers = useMemo(() => users.filter((person) => `${person.name} ${person.handle}`.toLowerCase().includes(query.toLowerCase())), [users, query])

  const refreshData = () => {
    setLoading(true)
    setError('')
    void loadData()
  }

  const startCall = useCallback(async (person: DirectoryUser, type: CallSession['type']) => {
    setError('')
    setCallFailure('')
    setBusyId(person.id)
    let createdCall: CallSession | null = null
    try {
      const response = await apiRequest<{ call: CallSession }>('/api/calls/start', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: person.id, type }),
      })
      createdCall = response.call
      setCallScreenId(response.call.id)
      replaceCall(response.call)
      await connectCall(response.call)
    } catch (startError) {
      const failureMessage = startError instanceof Error ? startError.message : 'Unable to start this call.'
      let cleanupError = ''
      if (createdCall) {
        await closeCallRoom(createdCall.id).catch((failure: unknown) => {
          cleanupError = failure instanceof Error ? failure.message : 'Media cleanup failed.'
        })
        try {
          const { call: cancelledCall } = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(createdCall.id)}/cancel`, { method: 'POST' })
          replaceCall(cancelledCall)
          setCallScreenId(cancelledCall.id)
          setCallFailure(failureMessage)
        } catch (failure) {
          cleanupError = [cleanupError, failure instanceof Error ? failure.message : 'The call could not be cancelled.'].filter(Boolean).join(' ')
        }
      }
      setError([failureMessage, cleanupError].filter(Boolean).join(' '))
    } finally {
      setBusyId('')
    }
  }, [closeCallRoom, connectCall, replaceCall])

  const startGroupCall = useCallback(async (conversationId: string, type: CallSession['type']) => {
    setError('')
    setCallFailure('')
    setBusyId(conversationId)
    let createdCall: CallSession | null = null
    try {
      const response = await apiRequest<{ call: CallSession }>('/api/calls/start', {
        method: 'POST',
        body: JSON.stringify({ conversationId, type }),
      })
      createdCall = response.call
      setCallScreenId(response.call.id)
      replaceCall(response.call)
      await connectCall(response.call)
    } catch (startError) {
      const failureMessage = startError instanceof Error ? startError.message : 'Unable to start this group call.'
      let cleanupError = ''
      if (createdCall) {
        await closeCallRoom(createdCall.id).catch((failure: unknown) => {
          cleanupError = failure instanceof Error ? failure.message : 'Media cleanup failed.'
        })
        try {
          const { call: cancelledCall } = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(createdCall.id)}/cancel`, { method: 'POST' })
          replaceCall(cancelledCall)
          setCallScreenId(cancelledCall.id)
          setCallFailure(failureMessage)
        } catch (failure) {
          cleanupError = [cleanupError, failure instanceof Error ? failure.message : 'The call could not be cancelled.'].filter(Boolean).join(' ')
        }
      }
      setError([failureMessage, cleanupError].filter(Boolean).join(' '))
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
    if (action === 'accept' || action === 'end' || action === 'leave' || action === 'cancel') setCallScreenId(call.id)
    setCallFailure('')
    let accepted = false
    try {
      const response = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/${action}`, { method: 'POST' })
      replaceCall(response.call)
      if (action === 'accept') {
        accepted = true
        await connectCall(response.call)
      }
      else {
        confirmedCallsRef.current.delete(call.id)
        await closeCallRoom(call.id)
      }
    } catch (actionError) {
      if (action === 'accept') {
        let message = actionError instanceof Error ? actionError.message : 'Unable to join this call.'
        if (accepted) {
          try {
            const { call: leftCall } = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/leave`, { method: 'POST' })
            replaceCall(leftCall)
            await closeCallRoom(call.id)
          } catch (cleanupError) {
            message = `${message} Unable to leave the failed call: ${cleanupError instanceof Error ? cleanupError.message : 'unknown error'}`
          }
        }
        setCallFailure(message)
        setError(message)
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
    setCallScreenId(call.id)
    setCallFailure('')
    try {
      await connectCall(call)
    } catch (joinError) {
      const message = joinError instanceof Error ? joinError.message : 'Unable to reconnect to this call.'
      setCallFailure(message)
      setError(message)
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

  const switchCallCamera = async () => {
    const room = roomRef.current
    if (!activeCall || activeCall.type !== 'video' || !room || !cameraOn || cameraSwitchBusy) return
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

  const selectAudioOutput = async (deviceId: string) => {
    const room = roomRef.current
    const selectedOutput = audioOutputs.find((device) => device.deviceId === deviceId)
    if (!activeCall || !room || !selectedOutput) return
    const currentId = room.getActiveDevice('audiooutput') ?? audioOutputId
    const nextSpeakerOn = /\b(speaker|built[\s-]?in)\b/i.test(selectedOutput.label)
    try {
      const switched = await room.switchActiveDevice('audiooutput', selectedOutput.deviceId, true)
      if (!switched) throw new Error('Your browser could not change the audio output route.')
      await apiRequest(`/api/calls/${encodeURIComponent(activeCall.id)}/speaker`, { method: 'POST', body: JSON.stringify({ speakerOn: nextSpeakerOn }) })
      setAudioOutputId(selectedOutput.deviceId)
    } catch (speakerError) {
      try {
        if (currentId) await room.switchActiveDevice('audiooutput', currentId, true)
      } catch (rollbackError) {
        setError(`${speakerError instanceof Error ? speakerError.message : 'Unable to change audio output.'} Audio route rollback failed: ${rollbackError instanceof Error ? rollbackError.message : 'unknown error'}`)
        return
      }
      setError(speakerError instanceof Error ? speakerError.message : 'Unable to change audio output.')
    }
  }

  const enablePlayback = async () => {
    const room = roomRef.current
    if (!room) return
    try {
      await room.startAudio()
      if (activeCall?.type === 'video') await room.startVideo()
      setNeedsAudioPlayback(false)
      if (activeCall?.type === 'video') setNeedsVideoPlayback(false)
    } catch (playbackError) {
      setError(playbackError instanceof Error ? playbackError.message : 'Unable to start media playback.')
    }
  }

  const nameFor = (userId: string) => userId === user?.id ? 'You' : users.find((person) => person.id === userId)?.name ?? 'NOVAKOKO member'
  const callTitle = (call: CallSession) => {
    if (call.conversationId) {
      const conversation = conversations.find((entry) => entry.id === call.conversationId)
      if (conversation?.name) return conversation.name
    }
    return call.participants.filter((participant) => participant.userId !== user?.id).map((participant) => nameFor(participant.userId)).join(', ') || 'NOVAKOKO call'
  }
  const callAvatar = (call: CallSession) => {
    if (call.conversationId) {
      const conversation = conversations.find((entry) => entry.id === call.conversationId)
      if (conversation?.isGroup) return resolveMediaUrl(conversation.imageUrl)
    }
    const other = call.participants.find((participant) => participant.userId !== user?.id)
    return other ? users.find((person) => person.id === other.userId)?.avatar ?? '' : ''
  }
  const activeCalls = calls.filter((call) => !['ended', 'cancelled', 'rejected', 'missed'].includes(call.status))
  const activeCall = calls.find((call) => call.id === (callScreenId || activeCallId))
  const localVideoTrack = activeRoom?.localParticipant.getTrackPublication(Track.Source.Camera)?.track
  const incomingCall = calls.find((call) => call.status === 'ringing' && call.callerId !== user?.id && call.participants.some((participant) => participant.userId === user?.id && participant.status === 'pending'))
  const screenState = activeCall ? callScreenState(activeCall, user?.id ?? '', Boolean(activeRoom && activeCall.status === 'connected'), Boolean(callFailure)) : null
  const callDuration = activeCall?.connectedAt ? formatCallDuration(callClock - new Date(activeCall.connectedAt).getTime()) : '00:00'

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header><p className="text-xs font-semibold uppercase text-indigo-700">Calls</p><h2 className="mt-2 text-2xl font-semibold text-slate-900">Call history</h2></header>
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" role="status">Calls use LiveKit for encrypted, low-latency voice and video. Your administrator must configure the LiveKit media server.</div>
      {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}

      {incomingCall && !activeCall ? <section aria-label="Incoming call" role="dialog" aria-modal="true" className={`${callViewportClassName} items-center justify-center gap-5`}>
        <Link to="/messages" className="absolute left-[max(1rem,env(safe-area-inset-left))] top-[max(1rem,env(safe-area-inset-top))] inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm text-white/80 hover:bg-white/10"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Messages</Link>
        <Avatar src={callAvatar(incomingCall)} alt={callTitle(incomingCall)} size="xl" />
        <div className="max-w-full text-center"><h2 className="break-words text-2xl font-semibold">{callTitle(incomingCall)}</h2><p className="mt-2 text-sm text-white/75">Incoming {incomingCall.type} call</p><p className="mt-1 text-sm text-emerald-200">Ringing</p></div>
        {error ? <p role="alert" className="max-w-md rounded-xl bg-rose-950/70 px-4 py-2 text-center text-sm text-rose-100">{error}</p> : null}
        <div className="mt-8 flex items-center gap-8">
          <button type="button" onClick={() => void callAction(incomingCall, 'reject')} disabled={busyId === incomingCall.id} className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg hover:bg-rose-700 disabled:opacity-50" aria-label="Reject call"><PhoneOff className="h-7 w-7" aria-hidden="true" /></button>
          <button type="button" onClick={() => void callAction(incomingCall, 'accept')} disabled={busyId === incomingCall.id || Boolean(activeCallId)} className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg hover:bg-emerald-700 disabled:opacity-50" aria-label="Accept call"><Phone className="h-7 w-7" aria-hidden="true" /></button>
        </div>
        {busyId === incomingCall.id ? <p className="text-sm text-white/75">Connecting securely…</p> : null}
      </section> : null}

      {activeCall && screenState ? <section aria-label={`${activeCall.type} call`} role="dialog" aria-modal="true" className={callViewportClassName}>
        <header className="flex items-center justify-between gap-3">
          <Link to="/messages" className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm text-white/80 hover:bg-white/10"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Messages</Link>
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-200">{activeCall.type === 'video' ? 'NOVAKOKO video call' : 'NOVAKOKO voice call'}</p>
        </header>
        <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-1 flex-col items-center justify-center py-6">
          <Avatar src={callAvatar(activeCall)} alt={callTitle(activeCall)} size="xl" />
          <h2 className="mt-5 max-w-full break-words text-center text-2xl font-semibold sm:text-3xl">{callTitle(activeCall)}</h2>
          <p className="mt-2 text-center text-sm text-white/75">
            {screenState === 'incoming' ? 'Incoming call'
              : screenState === 'outgoing' ? 'Ringing — waiting for an answer'
                : screenState === 'connecting' ? 'Connecting securely…'
                  : screenState === 'active' ? `Connected · ${callDuration}`
                    : screenState === 'failed' ? 'Call failed'
                      : activeCall.status === 'rejected' ? 'Call declined' : 'Call ended'}
          </p>
          {screenState === 'failed' && callFailure ? <p role="alert" className="mt-3 max-w-md rounded-xl bg-rose-950/70 px-4 py-2 text-center text-sm text-rose-100">{callFailure}</p> : null}
          {screenState === 'active' && activeCall.type === 'video' ? <div className="mt-6 grid w-full min-w-0 gap-3 sm:grid-cols-2">
            {remoteMedia.filter((entry) => entry.track.kind === Track.Kind.Video).map((entry) => <div key={entry.key} className="min-w-0 overflow-hidden rounded-2xl border border-white/15 bg-black"><p className="truncate px-3 py-2 text-xs text-white/70">{nameFor(entry.userId)}</p><AttachedTrack track={entry.track} className="aspect-video w-full object-cover" /></div>)}
            {localVideoTrack && cameraOn ? <div className="min-w-0 overflow-hidden rounded-2xl border border-white/15 bg-black"><p className="px-3 py-2 text-xs text-white/70">You</p><AttachedTrack track={localVideoTrack} muted className="aspect-video w-full object-cover" /></div> : null}
          </div> : null}
          {remoteMedia.filter((entry) => entry.track.kind === Track.Kind.Audio).map((entry) => <AttachedTrack key={entry.key} track={entry.track} className="hidden" />)}
          {needsAudioPlayback || needsVideoPlayback ? <Button variant="secondary" size="sm" className="mt-5" onClick={() => void enablePlayback()}>Enable media playback</Button> : null}
        </div>
        <footer className="mx-auto flex w-full max-w-lg flex-wrap items-center justify-center gap-2 pb-2 sm:gap-3">
          {screenState !== 'ended' && screenState !== 'failed' ? <>
            <button type="button" onClick={() => void toggleMute()} disabled={!activeRoom} className={`flex min-h-16 min-w-16 flex-col items-center justify-center gap-1 rounded-full ${muted ? 'bg-white text-slate-900' : 'bg-white/15 text-white'} disabled:opacity-40`} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}><span className="flex h-6 items-center">{muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}</span><span className="text-[10px]">{muted ? 'Unmute' : 'Mute'}</span></button>
            {activeCall.type === 'video' ? <button type="button" onClick={() => void toggleCamera()} disabled={!activeRoom} className={`flex min-h-16 min-w-16 flex-col items-center justify-center gap-1 rounded-full ${cameraOn ? 'bg-white/15 text-white' : 'bg-white text-slate-900'} disabled:opacity-40`} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}><span className="flex h-6 items-center">{cameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}</span><span className="text-[10px]">{cameraOn ? 'Camera off' : 'Camera on'}</span></button> : null}
            {activeCall.type === 'video' && cameraOn && localVideoTrack ? <button type="button" onClick={() => void switchCallCamera()} disabled={cameraSwitchBusy} className="flex min-h-16 min-w-16 flex-col items-center justify-center gap-1 rounded-full bg-white/15 text-white disabled:opacity-40" aria-label="Switch camera"><span className="flex h-6 items-center"><RefreshCw className="h-5 w-5" /></span><span className="text-[10px]">{cameraSwitchBusy ? 'Switching…' : 'Switch camera'}</span></button> : null}
            {audioOutputs.length > 1 && typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype ? <label className="flex min-h-16 min-w-20 flex-col items-center justify-center gap-1 rounded-xl bg-white/15 px-2 text-white"><Volume2 className="h-5 w-5" aria-hidden="true" /><span className="text-[10px]">Audio route</span><select aria-label="Audio output route" value={audioOutputId} onChange={(event) => void selectAudioOutput(event.target.value)} disabled={!activeRoom} className="max-w-28 bg-transparent text-center text-[10px] disabled:opacity-50"><option value="" disabled>Select output</option>{audioOutputs.map((output, index) => <option key={output.deviceId} value={output.deviceId} className="text-slate-900">{output.label || `Audio output ${index + 1}`}</option>)}</select></label> : null}
            <button type="button" onClick={() => void callAction(activeCall, activeCall.status === 'ringing' && activeCall.callerId === user?.id ? 'cancel' : activeCall.callerId === user?.id ? 'end' : 'leave')} disabled={Boolean(busyId)} className="flex min-h-16 min-w-16 flex-col items-center justify-center gap-1 rounded-full bg-rose-600 text-white shadow-lg hover:bg-rose-700 disabled:opacity-50" aria-label="End call"><PhoneOff className="h-6 w-6" aria-hidden="true" /><span className="text-[10px]">{activeCall.status === 'ringing' && activeCall.callerId === user?.id ? 'Cancel' : 'End'}</span></button>
          </> : <>
            <Link to="/messages" onClick={() => setCallScreenId('')} className="rounded-full bg-indigo-600 px-6 py-3 text-sm font-semibold text-white hover:bg-indigo-700">Back to Messages</Link>
            <button type="button" onClick={() => { setCallScreenId(''); setCallFailure('') }} className="rounded-full border border-white/30 px-6 py-3 text-sm font-semibold text-white hover:bg-white/10">Close</button>
          </>}
        </footer>
        {error && screenState !== 'failed' ? <p role="alert" className="mx-auto mb-3 max-w-lg text-center text-xs text-rose-200">{error}</p> : null}
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
