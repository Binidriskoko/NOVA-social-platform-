import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Archive, ArrowLeft, Image, Megaphone, MessageCircleMore, Mic, Phone, Pin, Search, SendHorizontal, Square, Star, UsersRound, UserPlus, VolumeX } from 'lucide-react'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { useAuth } from '../context/AuthContext'
import { apiRequest, fetchMediaBlob, resolveMediaUrl, uploadMedia, uploadMessageAttachment } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'

type ConversationParticipant = { userId: string; role?: string; user?: { id: string; name: string } }
type ConversationListItem = {
  id: string
  name: string | null
  isGroup?: boolean
  isChannel?: boolean
  participants: ConversationParticipant[]
  lastMessagePreview: string | null
  updatedAt: string
  lastMessageAt: string | null
  lastMessage?: { id: string; senderId: string; text: string; createdAt: string; readAt?: string | null; status?: string }
  pinnedAt?: string | null
  archivedAt?: string | null
  starredAt?: string | null
  mutedUntil?: string | null
  unreadCount?: number
}
type MessageReaction = { id?: string; userId: string; type: string }
type MessageItem = {
  id: string
  conversationId: string
  senderId: string
  text: string
  createdAt: string
  updatedAt: string
  readAt?: string | null
  deletedAt?: string | null
  status?: string
  contentType?: string
  mediaUrl?: string | null
  metadata?: Record<string, unknown> | null
  replyToId?: string | null
  forwardedFromId?: string | null
  editedAt?: string | null
  reactions?: MessageReaction[]
}
type DirectoryUser = { id: string; name: string }

function MessageMediaAttachment({ message, isOwn }: { message: MessageItem; isOwn: boolean }) {
  const [loadedMedia, setLoadedMedia] = useState<{ url: string; source: string; error: string }>({ url: '', source: '', error: '' })
  const mediaUrl = message.mediaUrl ?? ''
  const isUploaded = mediaUrl.startsWith('/api/media/')

  useEffect(() => {
    if (!isUploaded) return
    const controller = new AbortController()
    let objectUrl = ''
    void fetchMediaBlob(mediaUrl, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setLoadedMedia({ url: mediaUrl, source: objectUrl, error: '' })
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted) {
        setLoadedMedia({ url: mediaUrl, source: '', error: loadError instanceof Error ? loadError.message : 'Unable to load this attachment.' })
      }
    })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [isUploaded, mediaUrl])

  const matchesLoaded = loadedMedia.url === mediaUrl
  const source = isUploaded ? matchesLoaded ? loadedMedia.source : '' : resolveMediaUrl(mediaUrl)
  if (isUploaded && !matchesLoaded) return <p className="mb-2 text-xs text-slate-500">Loading attachment…</p>
  if (matchesLoaded && loadedMedia.error) return <p className="mb-2 text-xs text-rose-700" role="alert">{loadedMedia.error}</p>
  if (!source) return null
  if (message.contentType === 'IMAGE') return <a href={source} target="_blank" rel="noreferrer"><img src={source} alt="Message attachment" className="mb-2 max-h-64 rounded-xl object-cover" /></a>
  if (message.contentType === 'VIDEO') return <video controls src={source} className="mb-2 max-h-64 rounded-xl" />
  if (message.contentType === 'VOICE') return <audio controls src={source} className="mb-2 max-w-full" />
  if (message.contentType === 'DOCUMENT') {
    const filename = mediaUrl.toLowerCase().endsWith('.pdf') ? 'attachment.pdf' : 'attachment.docx'
    return <div className="mb-2 flex flex-wrap gap-3">
      <a href={source} target="_blank" rel="noreferrer" className={`underline ${isOwn ? 'text-white' : 'text-indigo-700'}`}>Open document</a>
      <a href={source} download={filename} className={`underline ${isOwn ? 'text-white' : 'text-indigo-700'}`}>Download document</a>
    </div>
  }
  return null
}

export function MessagesPage() {
  const { user } = useAuth()
  const [conversations, setConversations] = useState<ConversationListItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [messages, setMessages] = useState<MessageItem[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const [conversationFilter, setConversationFilter] = useState<'all' | 'unread' | 'groups'>('all')
  const [messageSearch, setMessageSearch] = useState('')
  const [searchResults, setSearchResults] = useState<MessageItem[] | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showAddMembers, setShowAddMembers] = useState(false)
  const [selectedAddParticipants, setSelectedAddParticipants] = useState<string[]>([])
  const [isGroup, setIsGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [directoryError, setDirectoryError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [replyTarget, setReplyTarget] = useState<MessageItem | null>(null)
  const [editingId, setEditingId] = useState('')
  const [editDraft, setEditDraft] = useState('')
  const [forwardingId, setForwardingId] = useState('')
  const [forwardTargetId, setForwardTargetId] = useState('')
  const [showMedia, setShowMedia] = useState(false)
  const [media, setMedia] = useState<MessageItem[]>([])
  const [composeType, setComposeType] = useState('TEXT')
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaFile, setMediaFileState] = useState<File | null>(null)
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState('')
  const [recording, setRecording] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const mediaPreviewUrlRef = useRef('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [locationLabel, setLocationLabel] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const setMediaFile = (file: File | null) => {
    if (mediaPreviewUrlRef.current) URL.revokeObjectURL(mediaPreviewUrlRef.current)
    mediaPreviewUrlRef.current = file ? URL.createObjectURL(file) : ''
    setMediaPreviewUrl(mediaPreviewUrlRef.current)
    setMediaFileState(file)
  }

  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.onstop = null
      recorderRef.current.stop()
    }
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
    if (mediaPreviewUrlRef.current) URL.revokeObjectURL(mediaPreviewUrlRef.current)
  }, [])

  const loadConversations = async () => {
    try {
      setLoading(true)
      setError('')
      const response = await apiRequest<{ conversations: ConversationListItem[] }>('/api/conversations')
      setConversations(response.conversations)
      setSelectedId((current) => current || response.conversations[0]?.id || '')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load conversations.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadConversations() }, [])

  useEffect(() => {
    const source = openAuthenticatedEventStream('/api/realtime')
    const onMessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { conversationId: string; message?: MessageItem; messageId?: string; reactions?: MessageReaction[]; deleted?: boolean }
        if (payload.conversationId === selectedId) {
          if (payload.message) {
            setMessages((current) => current.some((message) => message.id === payload.message!.id)
              ? current.map((message) => message.id === payload.message!.id ? payload.message! : message)
              : [...current, payload.message!])
          } else if (payload.messageId && payload.reactions) {
            setMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, reactions: payload.reactions } : message))
          }
        }
        void loadConversations()
      } catch {
        setError('A live message update could not be read. Reopen the conversation to refresh.')
      }
    }
    const onRead = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { messageId: string; readAt: string }
        setMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, readAt: payload.readAt, status: 'READ' } : message))
      } catch {
        setError('A read status update could not be read.')
      }
    }
    source.addEventListener('message:new', onMessage)
    source.addEventListener('message:read', onRead)
    return () => source.close()
  }, [selectedId])

  useEffect(() => {
    if (!selectedId) {
      setMessages([])
      return
    }

    const loadMessages = async () => {
      try {
        setMessagesLoading(true)
        setError('')
        const response = await apiRequest<{ messages: MessageItem[]; hasMore: boolean }>(`/api/conversations/${encodeURIComponent(selectedId)}/messages?limit=50`)
        setMessages(response.messages)
        setHasMore(response.hasMore)
        await apiRequest(`/api/conversations/${encodeURIComponent(selectedId)}/read`, { method: 'POST' })
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load messages.')
      } finally {
        setMessagesLoading(false)
      }
    }

    void loadMessages()
  }, [selectedId])

  const loadDirectory = async () => {
    setDirectoryError('')
    try {
      const response = await apiRequest<{ users: DirectoryUser[] }>('/api/users')
      setDirectory(response.users.filter((directoryUser) => directoryUser.id !== user?.id))
    } catch (loadError) {
      setDirectoryError(loadError instanceof Error ? loadError.message : 'Unable to load users.')
    }
  }

  const openNewConversation = async () => {
    setShowNew((current) => !current)
    setSelectedParticipants([])
    if (!directory.length) await loadDirectory()
  }

  const createConversation = async (participantId?: string) => {
    try {
      const payload = isGroup
        ? { participantIds: selectedParticipants, ...(groupName.trim() ? { name: groupName.trim() } : {}) }
        : { participantId }
      const response = await apiRequest<{ conversation: { id: string } }>('/api/conversations', { method: 'POST', body: JSON.stringify(payload) })
      await loadConversations()
      setSelectedId(response.conversation.id)
      setShowNew(false)
      setIsGroup(false)
      setGroupName('')
      setSelectedParticipants([])
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to start conversation.')
    }
  }

  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === selectedId) ?? null, [conversations, selectedId])
  const activePeer = useMemo(() => activeConversation?.participants.find((participant) => participant.userId !== user?.id)?.user ?? null, [activeConversation, user])
  const addGroupMembers = async () => {
    if (!activeConversation || !selectedAddParticipants.length) return
    try {
      setError('')
      await apiRequest(`/api/conversations/${encodeURIComponent(activeConversation.id)}/participants`, {
        method: 'POST',
        body: JSON.stringify({ participantIds: selectedAddParticipants }),
      })
      setShowAddMembers(false)
      setSelectedAddParticipants([])
      await loadConversations()
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Unable to add members to this group.')
    }
  }
  const visibleConversations = useMemo(() => conversations
    .filter((conversation) => showArchived || !conversation.archivedAt)
    .filter((conversation) => conversationFilter === 'all'
      || (conversationFilter === 'unread'
        ? (conversation.unreadCount ?? 0) > 0
        : conversation.participants.length > 2 || Boolean(conversation.name)))
    .filter((conversation) => {
      const peer = conversation.participants.find((participant) => participant.userId !== user?.id)?.user
      return `${conversation.name ?? ''} ${peer?.name ?? ''}`.toLowerCase().includes(search.toLowerCase())
    })
    .sort((left, right) => Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()), [conversations, conversationFilter, search, showArchived, user?.id])

  const loadOlderMessages = async () => {
    if (!selectedId || !messages[0] || loadingOlder) return
    try {
      setLoadingOlder(true)
      const response = await apiRequest<{ messages: MessageItem[]; hasMore: boolean }>(`/api/conversations/${encodeURIComponent(selectedId)}/messages?limit=50&before=${encodeURIComponent(messages[0].createdAt)}`)
      setMessages((current) => [...response.messages, ...current])
      setHasMore(response.hasMore)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load older messages.')
    } finally {
      setLoadingOlder(false)
    }
  }

  const canSend = composeType === 'TEXT' ? Boolean(draft.trim())
    : ['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE'].includes(composeType) ? Boolean(mediaUrl.trim() || mediaFile)
      : composeType === 'CONTACT' ? Boolean(contactName.trim() && contactPhone.trim())
        : Boolean(latitude.trim() && longitude.trim())

  const selectMediaFile = (file?: File) => {
    if (!file) {
      setMediaFile(null)
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setMediaFile(null)
      setError('Attachments must be 10 MB or smaller.')
      return
    }
    const extension = file.name.split('.').at(-1)?.toLowerCase()
    const allowed: Record<string, Record<string, string>> = {
      IMAGE: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' },
      VIDEO: { mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg' },
      DOCUMENT: { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      VOICE: { webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4' },
    }
    const expectedType = extension ? allowed[composeType]?.[extension] : undefined
    const actualType = file.type.split(';')[0] || expectedType
    if (!expectedType || actualType !== expectedType) {
      setMediaFile(null)
      setError('Choose a supported file whose type matches its extension.')
      return
    }
    setError('')
    setMediaUrl('')
    setMediaFile(file.type === actualType ? file : new File([file], file.name, { type: actualType }))
  }

  const startVoiceRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording is not supported by this browser.')
      return
    }
    try {
      setError('')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const chunks: BlobPart[] = []
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      recorder.onstop = () => {
        const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0]
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
        const recorded = new File(chunks, `voice-message.${extension}`, { type })
        if (recorded.size > 10 * 1024 * 1024) {
          setError('The recording is larger than 10 MB. Record a shorter voice message.')
          setMediaFile(null)
        } else {
          setMediaFile(recorded)
        }
        setMediaUrl('')
        stream.getTracks().forEach((track) => track.stop())
        recordingStreamRef.current = null
        recorderRef.current = null
        setRecording(false)
      }
      recordingStreamRef.current = stream
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
    } catch (recordingError) {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop())
      recordingStreamRef.current = null
      setError(recordingError instanceof Error ? `Microphone unavailable: ${recordingError.message}` : 'Microphone permission was denied.')
    }
  }

  const stopVoiceRecording = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  const handleSendMessage = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSend || !selectedId || sending) return
    const metadata = composeType === 'CONTACT' ? { name: contactName.trim(), phone: contactPhone.trim() }
      : composeType === 'LOCATION' ? { label: locationLabel.trim(), latitude: Number(latitude), longitude: Number(longitude) }
        : undefined
    try {
      setSending(true)
      setError('')
      const attachmentUrl = mediaFile
        ? (composeType === 'IMAGE' ? await uploadMedia(mediaFile) : await uploadMessageAttachment(mediaFile)).mediaUrl
        : mediaUrl.trim()
      if (mediaFile) {
        setMediaUrl(attachmentUrl)
        setMediaFile(null)
      }
      const response = await apiRequest<{ message: MessageItem }>(`/api/conversations/${encodeURIComponent(selectedId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          contentType: composeType,
          ...(draft.trim() ? { text: draft.trim() } : {}),
          ...(attachmentUrl ? { mediaUrl: attachmentUrl } : {}),
          ...(metadata ? { metadata } : {}),
          ...(replyTarget ? { replyToId: replyTarget.id } : {}),
        }),
      })
      setMessages((current) => current.some((message) => message.id === response.message.id) ? current : [...current, response.message])
      setDraft('')
      setMediaUrl('')
      setMediaFile(null)
      setContactName('')
      setContactPhone('')
      setLocationLabel('')
      setLatitude('')
      setLongitude('')
      setReplyTarget(null)
      await loadConversations()
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send message.')
    } finally {
      setSending(false)
    }
  }

  const searchMessages = async (event: FormEvent) => {
    event.preventDefault()
    if (messageSearch.trim().length < 2) return
    try {
      setError('')
      const response = await apiRequest<{ messages: MessageItem[] }>(`/api/messages/search?q=${encodeURIComponent(messageSearch.trim())}${selectedId ? `&conversationId=${encodeURIComponent(selectedId)}` : ''}`)
      setSearchResults(response.messages)
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Unable to search messages.')
    }
  }

  const toggleMedia = async () => {
    const next = !showMedia
    setShowMedia(next)
    if (!next || !selectedId) return
    try {
      const response = await apiRequest<{ media: MessageItem[] }>(`/api/conversations/${encodeURIComponent(selectedId)}/media`)
      setMedia(response.media)
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : 'Unable to load chat media.')
    }
  }

  const updatePreference = async (key: 'pinned' | 'archived' | 'starred' | 'mutedUntil') => {
    if (!activeConversation) return
    const currentlyEnabled = key === 'pinned' ? Boolean(activeConversation.pinnedAt)
      : key === 'archived' ? Boolean(activeConversation.archivedAt)
        : key === 'starred' ? Boolean(activeConversation.starredAt)
          : Boolean(activeConversation.mutedUntil && new Date(activeConversation.mutedUntil).getTime() > Date.now())
    const value = key === 'mutedUntil' ? (currentlyEnabled ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()) : !currentlyEnabled
    try {
      await apiRequest(`/api/conversations/${encodeURIComponent(activeConversation.id)}/preferences`, { method: 'PATCH', body: JSON.stringify({ [key]: value }) })
      await loadConversations()
    } catch (preferenceError) {
      setError(preferenceError instanceof Error ? preferenceError.message : 'Unable to update conversation settings.')
    }
  }

  const toggleReaction = async (message: MessageItem) => {
    try {
      const response = await apiRequest<{ reactions: MessageReaction[] }>(`/api/messages/${encodeURIComponent(message.id)}/reactions`, { method: 'POST', body: JSON.stringify({ type: 'LIKE' }) })
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, reactions: response.reactions } : item))
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Unable to react to this message.')
    }
  }

  const reportMessage = async (message: MessageItem) => {
    const reason = window.prompt('Why are you reporting this message?')
    if (!reason || reason.trim().length < 4) return
    try {
      await apiRequest(`/api/messages/${encodeURIComponent(message.id)}/report`, { method: 'POST', body: JSON.stringify({ category: 'OTHER', reason: reason.trim() }) })
      setError('Message report submitted for review.')
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unable to report this message.')
    }
  }

  const deleteMessage = async (message: MessageItem) => {
    if (!window.confirm('Delete this message?')) return
    try {
      const response = await apiRequest<{ message: MessageItem }>(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' })
      setMessages((current) => current.map((item) => item.id === message.id ? response.message : item))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this message.')
    }
  }

  const saveMessageEdit = async (message: MessageItem) => {
    try {
      const response = await apiRequest<{ message: MessageItem }>(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'PATCH', body: JSON.stringify({ text: editDraft.trim() }) })
      setMessages((current) => current.map((item) => item.id === message.id ? response.message : item))
      setEditingId('')
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : 'Unable to edit this message.')
    }
  }

  const forwardMessage = async (message: MessageItem) => {
    if (!forwardTargetId) return
    try {
      await apiRequest(`/api/messages/${encodeURIComponent(message.id)}/forward`, { method: 'POST', body: JSON.stringify({ conversationId: forwardTargetId }) })
      setForwardingId('')
      setForwardTargetId('')
      setError('Message forwarded.')
      await loadConversations()
    } catch (forwardError) {
      setError(forwardError instanceof Error ? forwardError.message : 'Unable to forward this message.')
    }
  }

  return (
    <div className="flex h-[calc(100dvh-9.5rem)] min-h-0 w-full flex-col overflow-hidden bg-[#f4f6fb] p-0 sm:p-2 lg:h-[calc(100dvh-7rem)]">
      <header className="mx-auto w-full max-w-7xl shrink-0 border-b border-blue-900/20 bg-gradient-to-r from-[#10214f] via-blue-800 to-indigo-700 p-3 text-white shadow-sm sm:rounded-t-2xl sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-200">NOVAKOKO Connect</p><h2 className="mt-1 text-xl font-semibold sm:text-2xl">Messages</h2></div>
          <p className="text-sm text-blue-100">Your chats, groups, and communities in one place.</p>
        </div>
        <nav aria-label="Communication sections" className="mt-4 flex gap-2 overflow-x-auto pb-1">
          <Link to="/messages" aria-current="page" className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-blue-800"><MessageCircleMore className="h-4 w-4" aria-hidden="true" />Chats</Link>
          <Link to="/communities?type=GROUP" className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"><UsersRound className="h-4 w-4" aria-hidden="true" />Groups</Link>
          <Link to="/communities?type=COMMUNITY" className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"><UsersRound className="h-4 w-4" aria-hidden="true" />Communities</Link>
          <Link to="/communities?type=CHANNEL" className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"><Megaphone className="h-4 w-4" aria-hidden="true" />Channels</Link>
          <Link to="/calls" className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"><Phone className="h-4 w-4" aria-hidden="true" />Calls</Link>
        </nav>
      </header>
      <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 overflow-hidden rounded-b-[26px] border border-blue-100 bg-white shadow-[0_18px_60px_-38px_rgba(18,35,87,.35)] lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className={`${selectedId ? 'hidden lg:block' : 'block'} min-h-0 min-w-0 overflow-y-auto border-b border-slate-200 bg-white p-3 lg:border-b-0 lg:border-r lg:p-4`}>
          <div className="flex items-center justify-between gap-3">
            <div><h3 className="text-lg font-semibold text-slate-900">Chats</h3><p className="text-xs text-slate-500">Private and group conversations</p></div>
            <Button variant="primary" size="sm" onClick={() => void openNewConversation()}>New chat</Button>
          </div>

          {showNew ? (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="flex gap-2">
                <Button variant={!isGroup ? 'primary' : 'secondary'} size="sm" onClick={() => setIsGroup(false)}>Direct</Button>
                <Button variant={isGroup ? 'primary' : 'secondary'} size="sm" onClick={() => setIsGroup(true)}>Group</Button>
              </div>
              <p className="mt-3 text-xs font-semibold uppercase text-slate-500">{isGroup ? 'Choose group members' : 'Start a conversation'}</p>
              {isGroup ? <input aria-label="Group name" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name (optional)" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" /> : null}
              {directoryError ? <p role="alert" className="mt-2 text-xs text-slate-600">{directoryError}</p> : null}
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto overscroll-contain">
                {directory.map((directoryUser) => (
                  <label key={directoryUser.id} className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 hover:bg-slate-100">
                    {isGroup ? <input type="checkbox" checked={selectedParticipants.includes(directoryUser.id)} onChange={(event) => setSelectedParticipants((current) => event.target.checked ? [...current, directoryUser.id] : current.filter((id) => id !== directoryUser.id))} /> : null}
                    <span className="min-w-0 flex-1 text-sm font-medium text-slate-900">{directoryUser.name}</span>
                    {!isGroup ? <button type="button" onClick={() => void createConversation(directoryUser.id)} className="text-xs font-semibold text-indigo-700">Open</button> : null}
                  </label>
                ))}
              </div>
              {isGroup ? <Button variant="primary" size="sm" className="mt-2 w-full" disabled={!selectedParticipants.length} onClick={() => void createConversation()}>Create group</Button> : null}
            </div>
          ) : null}

          <label className="mt-4 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-500 shadow-sm">
            <Search className="h-4 w-4" aria-hidden="true" />
            <input aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} className="w-full border-0 bg-transparent text-slate-800 placeholder:text-slate-400 focus:outline-none" />
          </label>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Filter conversations">
            {([
              ['all', 'All chats'],
              ['unread', 'Unread'],
              ['groups', 'Groups'],
            ] as const).map(([filter, label]) => (
              <button key={filter} type="button" aria-pressed={conversationFilter === filter} onClick={() => setConversationFilter(filter)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${conversationFilter === filter ? 'bg-blue-700 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-blue-50'}`}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setShowArchived((current) => !current)} className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-slate-600"><Archive className="h-4 w-4" aria-hidden="true" />{showArchived ? 'Hide archived' : 'Show archived'}</button>

          <div className="mt-3 space-y-2">
            {loading ? <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-500">Loading conversations…</div> : null}
            {!loading && conversations.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">No conversations yet.</div> : null}
            {!loading && conversations.length > 0 && visibleConversations.length === 0 ? <div className="rounded-2xl bg-white p-3 text-sm text-slate-500">No matching conversations.</div> : null}
            {visibleConversations.map((conversation) => {
              const lastMessage = conversation.lastMessage ?? null
              const peer = conversation.participants.find((participant) => participant.userId !== user?.id)?.user
              const title = conversation.name ?? peer?.name ?? 'Group conversation'
              return (
                <button key={conversation.id} type="button" onClick={() => { setSelectedId(conversation.id); setSearchResults(null) }} className={`flex w-full items-center gap-3 rounded-xl p-3 text-left transition ${selectedId === conversation.id ? 'bg-indigo-50 ring-1 ring-indigo-100' : 'hover:bg-slate-100'}`}>
                  <Avatar src="" alt={title} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-slate-900">{title}</span>
                      {conversation.pinnedAt ? <Pin className="h-3.5 w-3.5 shrink-0 text-indigo-600" aria-label="Pinned" /> : null}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{lastMessage?.text ?? conversation.lastMessagePreview ?? 'Start the conversation'}</span>
                  </span>
                  {conversation.unreadCount ? <span aria-label={`${conversation.unreadCount} unread messages`} className="flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</span> : null}
                </button>
              )
            })}
          </div>
        </aside>

        <section className={`${selectedId ? 'flex' : 'hidden lg:flex'} h-full min-h-0 min-w-0 flex-col bg-[#f4f5fb] bg-[radial-gradient(#d9dced_1px,transparent_1px)] [background-size:18px_18px] p-0`}>
          {error ? <div className="mb-3 rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-600" role="alert">{error}</div> : null}
          {activeConversation ? (
            <>
              <header className="sticky top-0 z-10 flex min-h-14 items-center justify-between gap-1 border-b border-slate-200 bg-white px-1 py-2 shadow-sm">
                <div className="flex min-w-0 items-center gap-3">
                  <button type="button" onClick={() => setSelectedId('')} aria-label="Back to chats" className="rounded-full p-2 text-slate-500 hover:bg-blue-50 lg:hidden"><ArrowLeft className="h-5 w-5" aria-hidden="true" /></button>
                  <Avatar src="" alt={activeConversation.name ?? activePeer?.name ?? 'Group'} size="md" />
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{activeConversation.name ?? activePeer?.name ?? 'Group conversation'}</p>
                    {activePeer ? <Link to={`/profile/${encodeURIComponent(activePeer.id)}`} className="text-xs text-indigo-700">View profile</Link> : <p className="text-xs text-slate-500">{activeConversation.participants.length} members</p>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto">
                  {activeConversation.isGroup && activeConversation.participants.some((participant) => participant.userId === user?.id && ['OWNER', 'MODERATOR'].includes(participant.role ?? '')) ? <button type="button" title="Add group members" aria-label="Add group members" onClick={() => { setShowAddMembers((open) => !open); setSelectedAddParticipants([]); if (!directory.length) void loadDirectory() }} className="rounded-full p-1.5 text-indigo-700 hover:bg-indigo-50"><UserPlus className="h-4 w-4" aria-hidden="true" /></button> : null}
                  <Link to="/calls" title="Open voice and video calls" aria-label="Open calls" className="rounded-full p-1.5 text-blue-700 hover:bg-blue-50"><Phone className="h-4 w-4" aria-hidden="true" /></Link>
                  <button type="button" title="Pin conversation" aria-label="Pin conversation" onClick={() => void updatePreference('pinned')} className={`rounded-full p-1.5 ${activeConversation.pinnedAt ? 'text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}><Pin className="h-4 w-4" /></button>
                  <button type="button" title="Star conversation" aria-label="Star conversation" onClick={() => void updatePreference('starred')} className={`rounded-full p-1.5 ${activeConversation.starredAt ? 'text-amber-600' : 'text-slate-500 hover:bg-slate-100'}`}><Star className="h-4 w-4" /></button>
                  <button type="button" title="Mute for 24 hours" aria-label="Mute conversation" onClick={() => void updatePreference('mutedUntil')} className={`rounded-full p-1.5 ${activeConversation.mutedUntil && new Date(activeConversation.mutedUntil).getTime() > Date.now() ? 'text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}><VolumeX className="h-4 w-4" /></button>
                  <button type="button" title="Archive conversation" aria-label="Archive conversation" onClick={() => void updatePreference('archived')} className={`rounded-full p-1.5 ${activeConversation.archivedAt ? 'text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}><Archive className="h-4 w-4" /></button>
                  <button type="button" title="Shared media" aria-label="Shared media" onClick={() => void toggleMedia()} className="rounded-full p-1.5 text-slate-500 hover:bg-slate-100"><Image className="h-4 w-4" /></button>
                </div>
              </header>

              {showAddMembers && activeConversation.isGroup ? <section aria-label="Add group members" className="mt-2 rounded-xl border border-indigo-100 bg-white p-3">
                <h3 className="text-sm font-semibold text-slate-900">Add members</h3>
                {directoryError ? <p role="alert" className="mt-2 text-xs text-rose-700">{directoryError}</p> : null}
                <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                  {directory.filter((person) => !activeConversation.participants.some((participant) => participant.userId === person.id)).map((person) => <label key={person.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-slate-50">
                    <input type="checkbox" checked={selectedAddParticipants.includes(person.id)} onChange={(event) => setSelectedAddParticipants((current) => event.target.checked ? [...current, person.id] : current.filter((id) => id !== person.id))} />
                    <span className="text-sm text-slate-800">{person.name}</span>
                  </label>)}
                  {directory.filter((person) => !activeConversation.participants.some((participant) => participant.userId === person.id)).length === 0 ? <p className="py-2 text-xs text-slate-500">Everyone is already in this group.</p> : null}
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowAddMembers(false)}>Cancel</Button>
                  <Button variant="primary" size="sm" disabled={!selectedAddParticipants.length} onClick={() => void addGroupMembers()}>Add selected</Button>
                </div>
              </section> : null}

              {showMedia ? <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-3">{media.length ? media.map((item) => item.mediaUrl ? <a key={item.id} href={resolveMediaUrl(item.mediaUrl)} target="_blank" rel="noreferrer" className="min-w-0 overflow-hidden rounded-lg bg-white text-xs text-indigo-700">{item.contentType === 'IMAGE' ? <img src={resolveMediaUrl(item.mediaUrl)} crossOrigin={item.mediaUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} alt="Shared image" className="aspect-square w-full object-cover" /> : <span className="block truncate p-2">{item.contentType}: {item.mediaUrl}</span>}</a> : null) : <p className="text-xs text-slate-500">No shared media.</p>}</div> : null}
              <form onSubmit={(event) => void searchMessages(event)} className="mt-2 flex gap-2 px-1">
                <input aria-label="Search messages" value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Search messages in this chat" minLength={2} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
                <Button type="submit" variant="secondary" size="sm" disabled={messageSearch.trim().length < 2} icon={<Search className="h-4 w-4" aria-hidden="true" />}>Search</Button>
                {searchResults ? <Button type="button" variant="ghost" size="sm" onClick={() => setSearchResults(null)}>Clear</Button> : null}
              </form>

              <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-2 pb-2 sm:px-3">
                {hasMore && !searchResults ? <Button variant="secondary" size="sm" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older messages'}</Button> : null}
                {messagesLoading ? <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">Loading messages…</div> : null}
                {!messagesLoading && searchResults && searchResults.length === 0 ? <p className="text-center text-sm text-slate-500">No matching messages.</p> : null}
                {!messagesLoading && !searchResults && messages.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">No messages yet. Start the conversation.</div> : null}
                {(searchResults ?? messages).map((message) => {
                  const isOwn = message.senderId === user?.id
                  const reply = message.replyToId ? messages.find((item) => item.id === message.replyToId) : null
                  return (
                    <div key={message.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%] ${isOwn ? 'bg-blue-600 text-white' : 'bg-white text-slate-700'}`}>
                        {message.forwardedFromId ? <p className={`mb-1 text-[10px] ${isOwn ? 'text-indigo-100' : 'text-slate-500'}`}>Forwarded</p> : null}
                        {reply ? <p className={`mb-2 border-l-2 pl-2 text-xs ${isOwn ? 'border-indigo-200 text-indigo-100' : 'border-indigo-400 text-slate-500'}`}>{reply.text}</p> : null}
                        {['IMAGE', 'VIDEO', 'VOICE', 'DOCUMENT'].includes(message.contentType ?? '') && message.mediaUrl ? <MessageMediaAttachment message={message} isOwn={isOwn} /> : null}
                        {message.contentType === 'VOICE' && message.mediaUrl ? <audio controls crossOrigin={message.mediaUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} src={resolveMediaUrl(message.mediaUrl)} className="mb-2 max-w-full" /> : null}
                        {message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null}
                        {message.contentType === 'CONTACT' && message.metadata ? <p>{String(message.metadata.name ?? 'Contact')} · {String(message.metadata.phone ?? '')}</p> : null}
                        {message.contentType === 'LOCATION' && message.metadata ? <p>{String(message.metadata.label ?? 'Location')} · {String(message.metadata.latitude)}, {String(message.metadata.longitude)}</p> : null}
                        <div className={`mt-1 flex items-center gap-1 text-[10px] ${isOwn ? 'text-indigo-100' : 'text-slate-500'}`}>
                          <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                          {message.editedAt ? <span>· edited</span> : null}
                          {isOwn ? <span>· {message.readAt ? 'Read' : 'Sent'}</span> : null}
                        </div>
                        {message.reactions?.length ? <p className={`mt-1 text-xs ${isOwn ? 'text-indigo-100' : 'text-slate-500'}`}>{message.reactions.map((reaction) => reaction.type).join(' ')}</p> : null}
                        {!message.deletedAt ? <div className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] ${isOwn ? 'text-indigo-100' : 'text-slate-500'}`}>
                          <button type="button" onClick={() => setReplyTarget(message)} className="hover:underline">Reply</button>
                          <button type="button" onClick={() => void toggleReaction(message)} className="hover:underline">React</button>
                          <button type="button" onClick={() => { setForwardingId(forwardingId === message.id ? '' : message.id); setForwardTargetId('') }} className="hover:underline">Forward</button>
                          {!isOwn ? <button type="button" onClick={() => void reportMessage(message)} className="hover:underline">Report</button> : null}
                          {isOwn && message.contentType === 'TEXT' ? <button type="button" onClick={() => { setEditingId(message.id); setEditDraft(message.text) }} className="hover:underline">Edit</button> : null}
                          {isOwn ? <button type="button" onClick={() => void deleteMessage(message)} className="hover:underline">Delete</button> : null}
                        </div> : null}
                        {editingId === message.id ? <div className="mt-2 flex gap-2"><input value={editDraft} onChange={(event) => setEditDraft(event.target.value)} className="min-w-0 flex-1 rounded-lg px-2 py-1 text-slate-900" /><button type="button" onClick={() => void saveMessageEdit(message)} className="font-semibold">Save</button><button type="button" onClick={() => setEditingId('')}>Cancel</button></div> : null}
                        {forwardingId === message.id ? <div className="mt-2 flex gap-2"><select aria-label="Forward to conversation" value={forwardTargetId} onChange={(event) => setForwardTargetId(event.target.value)} className="min-w-0 flex-1 rounded-lg px-2 py-1 text-slate-900"><option value="">Choose chat</option>{conversations.filter((item) => item.id !== selectedId).map((item) => <option key={item.id} value={item.id}>{item.name ?? item.participants.find((participant) => participant.userId !== user?.id)?.user?.name ?? 'Group chat'}</option>)}</select><button type="button" disabled={!forwardTargetId} onClick={() => void forwardMessage(message)} className="font-semibold disabled:opacity-50">Send</button></div> : null}
                      </div>
                    </div>
                  )
                })}
              </div>

              <form onSubmit={(event) => void handleSendMessage(event)} className="sticky bottom-0 mt-1 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg">
                {replyTarget ? <div className="mb-2 flex items-center justify-between rounded-xl bg-white px-3 py-2 text-xs text-slate-600"><span className="truncate">Replying to: {replyTarget.text || replyTarget.contentType}</span><button type="button" onClick={() => setReplyTarget(null)} aria-label="Cancel reply">×</button></div> : null}
                <div className="flex flex-wrap gap-2">
                  <select aria-label="Message type" value={composeType} disabled={recording} onChange={(event) => { setComposeType(event.target.value); setMediaFile(null); setMediaUrl('') }} className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs text-slate-700">
                    {['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE', 'CONTACT', 'LOCATION'].map((type) => <option key={type} value={type}>{type[0] + type.slice(1).toLowerCase()}</option>)}
                  </select>
                  {['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE'].includes(composeType) ? <input type="url" aria-label="Attachment URL" value={mediaUrl} onChange={(event) => { setMediaUrl(event.target.value); setMediaFile(null) }} placeholder="Attachment URL" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /> : null}
                  {['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE'].includes(composeType) ? <label className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-600">
                    {composeType === 'IMAGE' ? 'Upload image' : composeType === 'VIDEO' ? 'Choose or capture video' : composeType === 'DOCUMENT' ? 'Choose PDF or DOCX' : 'Choose audio file'} (up to 10 MB)
                    <input
                      type="file"
                      accept={composeType === 'IMAGE' ? 'image/jpeg,image/png,image/webp' : composeType === 'VIDEO' ? 'video/mp4,video/webm,video/ogg' : composeType === 'DOCUMENT' ? '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'audio/webm,audio/ogg,audio/mpeg,audio/mp4'}
                      capture={composeType === 'VIDEO' ? 'environment' : undefined}
                      aria-label={`Upload message ${composeType.toLowerCase()}`}
                      onChange={(event) => selectMediaFile(event.target.files?.[0])}
                      className="mt-1 block w-full text-xs"
                    />
                  </label> : null}
                  {composeType === 'VOICE' ? <Button type="button" variant="secondary" size="sm" disabled={sending} onClick={recording ? stopVoiceRecording : () => void startVoiceRecording()} icon={recording ? <Square className="h-4 w-4" aria-hidden="true" /> : <Mic className="h-4 w-4" aria-hidden="true" />}>{recording ? 'Stop recording' : 'Record voice'}</Button> : null}
                  {mediaFile && mediaPreviewUrl ? <div className="w-full rounded-xl bg-slate-50 p-2 text-xs text-slate-600">
                    {composeType === 'VIDEO' ? <video controls src={mediaPreviewUrl} className="max-h-48 rounded-lg" /> : null}
                    {composeType === 'VOICE' ? <audio controls src={mediaPreviewUrl} className="max-w-full" /> : null}
                    {composeType === 'DOCUMENT' ? <p>Ready to send: {mediaFile.name}</p> : null}
                    <button type="button" onClick={() => setMediaFile(null)} className="mt-1 font-medium text-rose-700">Remove attachment</button>
                  </div> : null}
                  {composeType === 'CONTACT' ? <><input aria-label="Contact name" value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Contact name" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /><input aria-label="Contact phone" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="Phone number" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /></> : null}
                  {composeType === 'LOCATION' ? <><input aria-label="Location label" value={locationLabel} onChange={(event) => setLocationLabel(event.target.value)} placeholder="Place name" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /><input aria-label="Latitude" type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="Latitude" className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" /><input aria-label="Longitude" type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="Longitude" className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" /></> : null}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <input aria-label="Type message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && composeType === 'TEXT') { event.preventDefault(); void handleSendMessage() } }} placeholder={composeType === 'TEXT' ? 'Write a message…' : 'Optional message'} className="min-w-0 flex-1 border-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
                  <Button type="submit" variant="primary" size="sm" disabled={sending || !canSend} icon={<SendHorizontal className="h-4 w-4" aria-hidden="true" />}>{sending ? 'Sending…' : 'Send'}</Button>
                </div>
              </form>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6"><EmptyState title="No conversation selected" description="Choose a conversation or start a new one." /></div>
          )}
        </section>
      </div>
    </div>
  )
}