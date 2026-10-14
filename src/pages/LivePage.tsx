import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Headphones, Radio, Users } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'

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
type LiveSignal = { type: 'join' | 'leave' } | { type: 'offer' | 'answer'; sdp: string } | ({ type: 'candidate' } & RTCIceCandidateInit)

export function LivePage() {
  const { user } = useAuth()
  const [lives, setLives] = useState<LiveSession[]>([])
  const [joinedLive, setJoinedLive] = useState<LiveSession | null>(null)
  const [comment, setComment] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hostStreamRef = useRef<MediaStream | null>(null)
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>())
  const iceServersRef = useRef<RTCIceServer[] | null>(null)
  const joinedLiveRef = useRef<LiveSession | null>(null)
  const livesRef = useRef<LiveSession[]>([])
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)

  const setLiveState = (live: LiveSession) => {
    livesRef.current = livesRef.current.some((entry) => entry.id === live.id)
      ? livesRef.current.map((entry) => entry.id === live.id ? live : entry)
      : [live, ...livesRef.current]
    setLives(livesRef.current)
    if (joinedLiveRef.current?.id === live.id) {
      joinedLiveRef.current = live
      setJoinedLive(live)
    }
  }

  const sendSignal = async (liveId: string, to: string, signal: LiveSignal) => {
    await apiRequest(`/api/live/${encodeURIComponent(liveId)}/signaling`, {
      method: 'POST',
      body: JSON.stringify({ to, signal }),
    })
  }

  const rtcConfiguration = useCallback(async () => {
    if (!iceServersRef.current) {
      const response = await apiRequest<{ iceServers: RTCIceServer[] }>('/api/rtc/config')
      iceServersRef.current = response.iceServers
    }
    return { iceServers: iceServersRef.current }
  }, [])

  const applyQueuedCandidates = async (peer: RTCPeerConnection, peerId: string) => {
    const queued = pendingCandidatesRef.current.get(peerId) ?? []
    pendingCandidatesRef.current.delete(peerId)
    for (const candidate of queued) await peer.addIceCandidate(candidate)
  }

  const createLivePeer = useCallback(async (liveId: string, peerId: string, host: boolean) => {
    const existing = peerConnectionsRef.current.get(peerId)
    if (existing) return existing
    const peer = new RTCPeerConnection(await rtcConfiguration())
    peerConnectionsRef.current.set(peerId, peer)
    if (host) hostStreamRef.current?.getTracks().forEach((track) => peer.addTrack(track, hostStreamRef.current!))
    peer.onicecandidate = (event) => {
      if (!event.candidate) return
      void sendSignal(liveId, peerId, { type: 'candidate', ...event.candidate.toJSON() }).catch((signalError) => {
        setError(signalError instanceof Error ? signalError.message : 'Unable to send the live media candidate.')
      })
    }
    peer.ontrack = (event) => {
      const stream = event.streams[0]
      if (stream && !host) setRemoteStream(stream)
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') setError('The live media connection failed. Check network access or configure TURN relay in the server environment.')
    }
    return peer
  }, [rtcConfiguration])

  const handleLiveSignal = useCallback(async (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as { liveId: string; from: string; to: string; signal: LiveSignal }
      if (payload.to !== user?.id) return
      const live = livesRef.current.find((entry) => entry.id === payload.liveId)
      if (!live) return
      const isHost = live.hostId === user?.id
      if (payload.signal.type === 'join' && isHost) {
        if (!hostStreamRef.current) throw new Error('Start broadcasting before accepting viewers.')
        const peer = await createLivePeer(live.id, payload.from, true)
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        await sendSignal(live.id, payload.from, { type: 'offer', sdp: offer.sdp ?? '' })
      } else if (payload.signal.type === 'leave' && isHost) {
        peerConnectionsRef.current.get(payload.from)?.close()
        peerConnectionsRef.current.delete(payload.from)
      } else if (payload.signal.type === 'offer' && !isHost) {
        const peer = await createLivePeer(live.id, payload.from, false)
        await peer.setRemoteDescription({ type: 'offer', sdp: payload.signal.sdp })
        await applyQueuedCandidates(peer, payload.from)
        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        await sendSignal(live.id, payload.from, { type: 'answer', sdp: answer.sdp ?? '' })
      } else if (payload.signal.type === 'answer' && isHost) {
        const peer = peerConnectionsRef.current.get(payload.from)
        if (peer) {
          await peer.setRemoteDescription({ type: 'answer', sdp: payload.signal.sdp })
          await applyQueuedCandidates(peer, payload.from)
        }
      } else if (payload.signal.type === 'candidate') {
        const peer = peerConnectionsRef.current.get(payload.from)
        if (payload.signal.type !== 'candidate') return
     const candidate: RTCIceCandidateInit = {
       candidate: payload.signal.candidate,
       sdpMid: payload.signal.sdpMid,
       sdpMLineIndex: payload.signal.sdpMLineIndex,
       usernameFragment: payload.signal.usernameFragment,
     }
     if (peer?.remoteDescription) await peer.addIceCandidate(candidate)
        else pendingCandidatesRef.current.set(payload.from, [...(pendingCandidatesRef.current.get(payload.from) ?? []), candidate])
      }
    } catch (signalError) {
      setError(signalError instanceof Error ? signalError.message : 'Unable to process the live media signal.')
    }
  }, [createLivePeer, user?.id])

  const loadLives = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ lives: LiveSession[] }>('/api/live')
      livesRef.current = response.lives
      setLives(response.lives)
      if (joinedLiveRef.current) {
        const refreshed = response.lives.find((live) => live.id === joinedLiveRef.current?.id) ?? null
        joinedLiveRef.current = refreshed
        setJoinedLive(refreshed)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load live sessions.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadLives() }, [])

  useEffect(() => {
    const source = openAuthenticatedEventStream('/api/realtime')
    const onLiveUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { live?: LiveSession }
        if (!payload.live) return
        setLiveState(payload.live)
        if (payload.live.status === 'ended') {
          if (payload.live.hostId === user?.id) {
            hostStreamRef.current?.getTracks().forEach((track) => track.stop())
            hostStreamRef.current = null
            setLocalStream(null)
          }
          peerConnectionsRef.current.forEach((peer) => peer.close())
          peerConnectionsRef.current.clear()
          setRemoteStream(null)
        }
      } catch {
        setError('A live session update could not be read. Refresh to retry.')
      }
    }
    source.addEventListener('live:update', onLiveUpdate)
    source.addEventListener('live:signal', (event: MessageEvent<string>) => { void handleLiveSignal(event) })
    return () => source.close()
  }, [handleLiveSignal, user?.id])

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream
  }, [localStream])

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream
  }, [remoteStream])

  useEffect(() => () => {
    peerConnectionsRef.current.forEach((peer) => peer.close())
    hostStreamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

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
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support live video capture.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      hostStreamRef.current = stream
      setLocalStream(stream)
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/start`, { method: 'POST' })
      setLiveState(response.live)
    } catch (startError) {
      hostStreamRef.current?.getTracks().forEach((track) => track.stop())
      hostStreamRef.current = null
      setLocalStream(null)
      setError(startError instanceof Error ? startError.message : 'Unable to start the live broadcast.')
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
      hostStreamRef.current?.getTracks().forEach((track) => track.stop())
      hostStreamRef.current = null
      setLocalStream(null)
      peerConnectionsRef.current.forEach((peer) => peer.close())
      peerConnectionsRef.current.clear()
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : 'Unable to end this live session.')
    } finally {
      setBusy(false)
    }
  }

  const joinLive = async (live: LiveSession) => {
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/viewers/join`, { method: 'POST' })
      joinedLiveRef.current = response.live
      setJoinedLive(response.live)
      setLiveState(response.live)
      await sendSignal(live.id, live.hostId, { type: 'join' })
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to join this live session.')
    } finally {
      setBusy(false)
    }
  }

  const leaveLive = async () => {
    const currentLive = joinedLiveRef.current
    if (!currentLive) return
    setBusy(true)
    try {
      await sendSignal(currentLive.id, currentLive.hostId, { type: 'leave' })
      await apiRequest(`/api/live/${encodeURIComponent(currentLive.id)}/viewers/leave`, { method: 'POST' })
      peerConnectionsRef.current.forEach((peer) => peer.close())
      peerConnectionsRef.current.clear()
      setRemoteStream(null)
      joinedLiveRef.current = null
      setJoinedLive(null)
      await loadLives()
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : 'Unable to leave this session.')
    } finally {
      setBusy(false)
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

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase text-indigo-700"><Radio className="h-4 w-4" aria-hidden="true" /> Live</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900">Live sessions</h2>
      </header>

      <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900" role="status">Live video and audio are encrypted peer-to-peer with WebRTC. TURN relay can be configured by your administrator for restricted networks; direct peer connections do not need a paid media service.</div>
      {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p> : null}

      <form onSubmit={(event) => void createLive(event)} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold text-slate-900">Create a live session</h3>
        <input aria-label="Live session title" required maxLength={120} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="What are you going live about?" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <textarea aria-label="Live session description" maxLength={1000} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Add a description (optional)" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <div className="flex justify-end"><Button type="submit" variant="primary" size="sm" disabled={busy || !newTitle.trim()}>Create session</Button></div>
      </form>

      {hostLive && localStream ? <section className="rounded-2xl border border-indigo-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3"><div><h3 className="font-semibold text-slate-900">Your live broadcast</h3><p className="text-sm text-slate-600">{hostLive.title}</p></div><Button variant="secondary" size="sm" onClick={() => void endBroadcast(hostLive)} disabled={busy}>End broadcast</Button></div>
        <video ref={localVideoRef} autoPlay muted playsInline className="mt-3 aspect-video w-full rounded-xl bg-slate-950 object-cover" />
      </section> : null}

      {joinedLive ? (
        <section className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="font-semibold text-slate-900">{joinedLive.title}</h3><p className="text-sm text-slate-600">{remoteStream ? 'Encrypted live media connected.' : 'Connecting to the live broadcast…'}</p></div>
            <Button variant="secondary" size="sm" onClick={() => void leaveLive()} disabled={busy}>Leave session</Button>
          </div>
          <video ref={remoteVideoRef} autoPlay playsInline className="mt-3 aspect-video w-full rounded-xl bg-slate-950 object-contain" />
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

      <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={() => void loadLives()} disabled={loading}><Users className="h-4 w-4" aria-hidden="true" /> Refresh</Button></div>
    </div>
  )
}