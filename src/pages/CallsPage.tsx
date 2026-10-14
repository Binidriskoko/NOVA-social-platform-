import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Phone, Search, Video } from 'lucide-react'
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
type CallSignal = { type: 'offer' | 'answer'; sdp: string } | ({ type: 'candidate' } & RTCIceCandidateInit)
type RemoteMedia = { key: string; userId: string; stream: MediaStream }

export function CallsPage() {
  const { user } = useAuth()
  const [calls, setCalls] = useState<CallSession[]>([])
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [activeCallId, setActiveCallId] = useState('')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteMedia, setRemoteMedia] = useState<RemoteMedia[]>([])
  const [muted, setMuted] = useState(false)
  const [cameraOn, setCameraOn] = useState(true)
  const callsRef = useRef<CallSession[]>([])
  const peersRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingOffersRef = useRef(new Map<string, { callId: string; from: string; signal: CallSignal }>())
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>())
  const localStreamRef = useRef<MediaStream | null>(null)
  const iceServersRef = useRef<RTCIceServer[] | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)

  const replaceCall = (call: CallSession) => {
    callsRef.current = callsRef.current.some((item) => item.id === call.id)
      ? callsRef.current.map((item) => item.id === call.id ? call : item)
      : [call, ...callsRef.current]
    setCalls(callsRef.current)
  }

  const rtcConfiguration = useCallback(async () => {
    if (!iceServersRef.current) {
      const response = await apiRequest<{ iceServers: RTCIceServer[] }>('/api/rtc/config')
      iceServersRef.current = response.iceServers
    }
    return { iceServers: iceServersRef.current }
  }, [])

  const acquireMedia = async (type: CallSession['type']) => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support secure voice or video calls.')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' })
    localStreamRef.current = stream
    setLocalStream(stream)
    return stream
  }

  const signalPeer = async (callId: string, to: string, signal: CallSignal) => {
    await apiRequest(`/api/calls/${encodeURIComponent(callId)}/signaling`, {
      method: 'POST',
      body: JSON.stringify({ to, signal }),
    })
  }

  const establishPeer = useCallback(async (call: CallSession, remoteUserId: string, makeOffer: boolean) => {
    const key = `${call.id}:${remoteUserId}`
    const existing = peersRef.current.get(key)
    if (existing) return existing
    const peer = new RTCPeerConnection(await rtcConfiguration())
    peersRef.current.set(key, peer)
    localStreamRef.current?.getTracks().forEach((track) => peer.addTrack(track, localStreamRef.current!))
    peer.onicecandidate = (event) => {
      if (!event.candidate) return
      void signalPeer(call.id, remoteUserId, { type: 'candidate', ...event.candidate.toJSON() }).catch((signalError) => {
        setError(signalError instanceof Error ? signalError.message : 'Unable to send a secure media candidate.')
      })
    }
    peer.ontrack = (event) => {
      const stream = event.streams[0]
      if (!stream) return
      setRemoteMedia((current) => current.some((entry) => entry.key === key)
        ? current.map((entry) => entry.key === key ? { ...entry, stream } : entry)
        : [...current, { key, userId: remoteUserId, stream }])
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        void apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/connected`, { method: 'POST' })
          .then(({ call: updated }) => replaceCall(updated))
          .catch((connectionError) => setError(connectionError instanceof Error ? connectionError.message : 'Unable to confirm the secure call connection.'))
      } else if (peer.connectionState === 'failed') {
        setError('The secure media connection failed. Check network access or configure TURN relay in the server environment.')
      }
    }
    if (makeOffer) {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      await signalPeer(call.id, remoteUserId, { type: 'offer', sdp: offer.sdp ?? '' })
    }
    return peer
  }, [rtcConfiguration])

  const applyQueuedCandidates = async (peer: RTCPeerConnection, key: string) => {
    const queued = pendingCandidatesRef.current.get(key) ?? []
    pendingCandidatesRef.current.delete(key)
    for (const candidate of queued) await peer.addIceCandidate(candidate)
  }

  const handleCallSignal = useCallback(async (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as { callId: string; from: string; to: string; signal: CallSignal }
      if (payload.to !== user?.id) return
      const call = callsRef.current.find((item) => item.id === payload.callId)
      if (!call) return
      const peerKey = `${call.id}:${payload.from}`
      if (payload.signal.type === 'offer') {
        const own = call.participants.find((participant) => participant.userId === user?.id)
        if (own?.status !== 'accepted' && call.callerId !== user?.id) {
          pendingOffersRef.current.set(peerKey, payload)
          return
        }
        const peer = await establishPeer(call, payload.from, false)
        await peer.setRemoteDescription({ type: 'offer', sdp: payload.signal.sdp })
        await applyQueuedCandidates(peer, peerKey)
        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        await signalPeer(call.id, payload.from, { type: 'answer', sdp: answer.sdp ?? '' })
      } else if (payload.signal.type === 'answer') {
        const peer = peersRef.current.get(peerKey)
        if (!peer) return
        await peer.setRemoteDescription({ type: 'answer', sdp: payload.signal.sdp })
        await applyQueuedCandidates(peer, peerKey)
      } else {
        const peer = peersRef.current.get(peerKey)
        if (payload.signal.type !== 'candidate') return
     const candidate: RTCIceCandidateInit = {
       candidate: payload.signal.candidate,
       sdpMid: payload.signal.sdpMid,
       sdpMLineIndex: payload.signal.sdpMLineIndex,
       usernameFragment: payload.signal.usernameFragment,
     }
     if (peer?.remoteDescription) await peer.addIceCandidate(candidate)
        else pendingCandidatesRef.current.set(peerKey, [...(pendingCandidatesRef.current.get(peerKey) ?? []), candidate])
      }
    } catch (signalError) {
      setError(signalError instanceof Error ? signalError.message : 'Unable to process the encrypted call signal.')
    }
  }, [establishPeer, user?.id])

  const loadData = async () => {
    setLoading(true)
    setError('')
    try {
      const [history, directory] = await Promise.all([
        apiRequest<{ calls: CallSession[] }>('/api/calls/history'),
        apiRequest<{ users: DirectoryUser[] }>('/api/users'),
      ])
      callsRef.current = history.calls
      setCalls(history.calls)
      setUsers(directory.users.filter((person) => person.id !== user?.id))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load calls.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadData() }, [user?.id])

  useEffect(() => {
    const source = openAuthenticatedEventStream('/api/realtime')
    const onCallUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { call?: CallSession }
        if (payload.call?.participants.some((participant) => participant.userId === user?.id)) {
          replaceCall(payload.call)
        }
      } catch {
        setError('A call status update could not be read. Refresh call history to retry.')
      }
    }
    source.addEventListener('call:update', onCallUpdate)
    source.addEventListener('call:signal', handleCallSignal)
    return () => source.close()
  }, [handleCallSignal, user?.id])

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream
  }, [localStream])

  const filteredUsers = useMemo(() => users.filter((person) => `${person.name} ${person.handle}`.toLowerCase().includes(query.toLowerCase())), [users, query])

  const stopLocalMedia = () => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    setLocalStream(null)
  }

  const closeCallPeers = (callId: string) => {
    for (const [key, peer] of peersRef.current) {
      if (!key.startsWith(`${callId}:`)) continue
      peer.close()
      peersRef.current.delete(key)
    }
    setRemoteMedia((current) => current.filter((entry) => !entry.key.startsWith(`${callId}:`)))
    stopLocalMedia()
    setActiveCallId('')
  }

  const startCall = async (person: DirectoryUser, type: CallSession['type']) => {
    setError('')
    setBusyId(person.id)
    try {
      await acquireMedia(type)
      const response = await apiRequest<{ call: CallSession }>('/api/calls/start', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: person.id, type }),
      })
      replaceCall(response.call)
      setActiveCallId(response.call.id)
      await establishPeer(response.call, person.id, true)
    } catch (startError) {
      stopLocalMedia()
      setError(startError instanceof Error ? startError.message : 'Unable to start this call.')
    } finally {
      setBusyId('')
    }
  }

  const callAction = async (call: CallSession, action: 'accept' | 'reject' | 'cancel' | 'end' | 'leave') => {
    setBusyId(call.id)
    setError('')
    try {
      if (action === 'accept') await acquireMedia(call.type)
      const response = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/${action}`, { method: 'POST' })
      replaceCall(response.call)
      if (action === 'accept') {
        setActiveCallId(call.id)
        const ownOffer = pendingOffersRef.current.get(`${call.id}:${call.callerId}`)
        if (ownOffer) {
          pendingOffersRef.current.delete(`${call.id}:${call.callerId}`)
          await handleCallSignal(new MessageEvent('call:signal', { data: JSON.stringify(ownOffer) }))
        }
      } else {
        closeCallPeers(call.id)
      }
    } catch (actionError) {
      if (action === 'accept') stopLocalMedia()
      setError(actionError instanceof Error ? actionError.message : 'Unable to update this call.')
    } finally {
      setBusyId('')
    }
  }

  const toggleMute = async () => {
    if (!activeCall || !localStreamRef.current) return
    const nextMuted = !muted
    localStreamRef.current.getAudioTracks().forEach((track) => { track.enabled = !nextMuted })
    setMuted(nextMuted)
    try {
      await apiRequest(`/api/calls/${encodeURIComponent(activeCall.id)}/mute`, { method: 'POST', body: JSON.stringify({ muted: nextMuted }) })
    } catch (muteError) {
      localStreamRef.current.getAudioTracks().forEach((track) => { track.enabled = muted })
      setMuted(muted)
      setError(muteError instanceof Error ? muteError.message : 'Unable to update microphone state.')
    }
  }

  const toggleCamera = async () => {
    if (!activeCall || activeCall.type !== 'video' || !localStreamRef.current) return
    const nextCameraOn = !cameraOn
    localStreamRef.current.getVideoTracks().forEach((track) => { track.enabled = nextCameraOn })
    setCameraOn(nextCameraOn)
    try {
      await apiRequest(`/api/calls/${encodeURIComponent(activeCall.id)}/camera`, { method: 'POST', body: JSON.stringify({ cameraOn: nextCameraOn }) })
    } catch (cameraError) {
      localStreamRef.current.getVideoTracks().forEach((track) => { track.enabled = cameraOn })
      setCameraOn(cameraOn)
      setError(cameraError instanceof Error ? cameraError.message : 'Unable to update camera state.')
    }
  }

  useEffect(() => () => {
    peersRef.current.forEach((peer) => peer.close())
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  const nameFor = (userId: string) => userId === user?.id ? 'You' : users.find((person) => person.id === userId)?.name ?? 'NOVAKOKO member'
  const activeCalls = calls.filter((call) => !['ended', 'cancelled', 'rejected'].includes(call.status))
  const activeCall = calls.find((call) => call.id === activeCallId)

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header><p className="text-xs font-semibold uppercase text-indigo-700">Calls</p><h2 className="mt-2 text-2xl font-semibold text-slate-900">Call history</h2></header>
      <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" role="status">Calls use encrypted peer-to-peer WebRTC media. A TURN relay can be configured by your administrator for networks that block direct connections.</div>
      {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}

      {activeCall ? <section aria-label="Active call" className="rounded-2xl border border-indigo-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-semibold text-slate-900">{activeCall.type === 'video' ? 'Video call' : 'Voice call'}</h3><p className="text-sm text-slate-600">{activeCall.status === 'connected' ? 'Encrypted media connected' : activeCall.status === 'ringing' ? 'Ringing — awaiting an answer' : 'Establishing encrypted media…'}</p></div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={!localStream} onClick={() => void toggleMute()}>{muted ? 'Unmute' : 'Mute'}</Button>
            {activeCall.type === 'video' ? <Button variant="secondary" size="sm" disabled={!localStream} onClick={() => void toggleCamera()}>{cameraOn ? 'Turn camera off' : 'Turn camera on'}</Button> : null}
            <Button variant="primary" size="sm" onClick={() => void callAction(activeCall, 'leave')}>Leave call</Button>
          </div>
        </div>
        {activeCall.type === 'video' ? <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div><p className="mb-1 text-xs font-medium text-slate-500">You</p><video ref={localVideoRef} autoPlay muted playsInline className="aspect-video w-full rounded-xl bg-slate-950 object-cover" /></div>
          {remoteMedia.map((entry) => <div key={entry.key}><p className="mb-1 text-xs font-medium text-slate-500">{nameFor(entry.userId)}</p><video autoPlay playsInline ref={(element) => { if (element && element.srcObject !== entry.stream) element.srcObject = entry.stream }} className="aspect-video w-full rounded-xl bg-slate-950 object-cover" /></div>)}
        </div> : remoteMedia.map((entry) => <audio key={entry.key} autoPlay ref={(element) => { if (element && element.srcObject !== entry.stream) element.srcObject = entry.stream }} />)}
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
        <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-900">Recent and active calls</h3><Button variant="ghost" size="sm" onClick={() => void loadData()} disabled={loading}>Refresh</Button></div>
        {loading ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500">Loading call history…</p> : null}
        {!loading && calls.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No calls yet.</p> : null}
        <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
          {calls.map((call) => {
            const own = call.participants.find((participant) => participant.userId === user?.id)
            const counterparties = call.participants.filter((participant) => participant.userId !== user?.id).map((participant) => nameFor(participant.userId)).join(', ')
            const incoming = call.callerId !== user?.id && own?.status === 'pending'
            return <li key={call.id} className="flex flex-wrap items-center gap-3 p-4"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600">{call.type === 'video' ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-900">{counterparties || 'Call'}</p><p className="mt-1 text-xs text-slate-500">{call.type} · {call.status} · {new Date(call.createdAt).toLocaleString()}</p></div>{incoming ? <><Button variant="primary" size="sm" disabled={busyId === call.id || Boolean(activeCall)} onClick={() => void callAction(call, 'accept')}>Accept</Button><Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'reject')}>Decline</Button></> : null}{call.callerId === user?.id && call.status === 'ringing' ? <Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'cancel')}>Cancel</Button> : null}{call.status === 'connected' && own?.status !== 'left' ? <Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'leave')}>Leave</Button> : null}</li>
          })}
        </ul>
        {activeCalls.length > 0 ? <p className="mt-2 text-xs text-slate-500">A call is only marked connected after the browser confirms that encrypted WebRTC media is established.</p> : null}
      </section>
    </div>
  )
}