import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Camera, ImagePlus, MoreVertical, PencilLine, Plus, Search, X } from 'lucide-react'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest, resolveMediaUrl, uploadMedia, uploadVideo } from '../lib/api'

type StatusRecord = {
  id: string
  authorId: string
  text: string | null
  mediaUrl: string | null
  createdAt: string
  expiresAt: string
  viewedByMe: boolean
  viewCount: number
  author: { id: string; name: string; handle: string; avatar: string }
}
type Channel = { id: string; name: string | null; participants: { userId: string; user?: { name: string } }[] }

export function UpdatesPage() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [statuses, setStatuses] = useState<StatusRecord[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [error, setError] = useState('')
  const [channelsError, setChannelsError] = useState('')
  const [showComposer, setShowComposer] = useState(false)
  const [composerMode, setComposerMode] = useState<'text' | 'media'>('text')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [activeStatus, setActiveStatus] = useState<StatusRecord | null>(null)
  const [filter, setFilter] = useState<'recent' | 'unviewed' | 'viewed'>('recent')
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const mediaInputRef = useRef<HTMLInputElement | null>(null)
  const previewUrlRef = useRef('')

  const loadStatuses = async () => {
    try {
      setError('')
      const response = await apiRequest<{ statuses: StatusRecord[] }>('/api/statuses')
      setStatuses(response.statuses)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load statuses.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadStatuses() }, [])
  useEffect(() => {
    let active = true
    void apiRequest<{ conversations: (Channel & { isChannel?: boolean })[] }>('/api/conversations')
      .then((response) => {
        if (active) setChannels(response.conversations.filter((conversation) => conversation.isChannel))
      })
      .catch((loadError: unknown) => {
        if (active) setChannelsError(loadError instanceof Error ? loadError.message : 'Unable to load channels.')
      })
      .finally(() => { if (active) setChannelsLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setComposerMode('text')
      setShowComposer(true)
      setSearchParams((current) => {
        const next = new URLSearchParams(current)
        next.delete('create')
        return next
      }, { replace: true })
    }
  }, [searchParams, setSearchParams])
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  const visibleStatuses = useMemo(() => statuses
    .filter((status) => filter === 'recent' || (filter === 'viewed' ? status.viewedByMe : !status.viewedByMe))
    .filter((status) => `${status.author.name} ${status.author.handle} ${status.text ?? ''}`.toLowerCase().includes(search.toLowerCase())),
  [filter, search, statuses])

  const clearMedia = () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = ''
    setFile(null)
    setPreviewUrl('')
  }

  const selectMedia = (selected: File | null) => {
    if (!selected) return
    const types: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg',
    }
    const extension = selected.name.split('.').at(-1)?.toLowerCase() ?? ''
    if (selected.size > 10 * 1024 * 1024) {
      setError('Status media must be 10 MB or smaller.')
      return
    }
    if (!types[extension] || selected.type !== types[extension]) {
      setError('Choose a matching JPEG, PNG, WebP, MP4, WebM, or Ogg file.')
      return
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = URL.createObjectURL(selected)
    setFile(selected)
    setPreviewUrl(previewUrlRef.current)
    setComposerMode('media')
    setShowComposer(true)
    setError('')
  }

  const openTextComposer = () => {
    clearMedia()
    setComposerMode('text')
    setShowComposer(true)
  }

  const cancelComposer = () => {
    setShowComposer(false)
    setText('')
    clearMedia()
  }

  const publish = async () => {
    if (busy || (!text.trim() && !file)) return
    setBusy(true)
    setError('')
    try {
      const mediaUrl = file
        ? (file.type.startsWith('video/') ? await uploadVideo(file) : await uploadMedia(file)).mediaUrl
        : ''
      const response = await apiRequest<{ status: StatusRecord }>('/api/statuses', {
        method: 'POST',
        body: JSON.stringify({ ...(text.trim() ? { text: text.trim() } : {}), ...(mediaUrl ? { mediaUrl } : {}) }),
      })
      setStatuses((current) => [...current, response.status])
      setText('')
      clearMedia()
      setShowComposer(false)
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Unable to publish this status.')
    } finally {
      setBusy(false)
    }
  }

  const openStatus = async (status: StatusRecord) => {
    try {
      await apiRequest<{ viewed: boolean; viewCount: number }>(`/api/statuses/${encodeURIComponent(status.id)}/view`, { method: 'POST' })
      const opened = { ...status, viewedByMe: true, viewCount: status.viewCount + (status.viewedByMe || status.authorId === user?.id ? 0 : 1) }
      setStatuses((current) => current.map((item) => item.id === status.id ? opened : item))
      setActiveStatus(opened)
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : 'Unable to open this status.')
    }
  }

  const deleteStatus = async (status: StatusRecord) => {
    try {
      await apiRequest(`/api/statuses/${encodeURIComponent(status.id)}`, { method: 'DELETE' })
      setStatuses((current) => current.filter((item) => item.id !== status.id))
      setActiveStatus(null)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this status.')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white text-slate-900">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-4">
        <div className="min-w-0"><p className="text-xs font-bold text-slate-900">NOVAKOKO</p><h1 className="text-lg font-semibold">Status</h1></div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={openTextComposer} aria-label="Create a text status" title="Text status" className="rounded-full p-2 text-[#087b43] hover:bg-[#e8f5e9]"><PencilLine className="h-5 w-5" /></button>
          <button type="button" onClick={() => mediaInputRef.current?.click()} aria-label="Create a photo or video status" title="Media status" className="rounded-full p-2 text-[#087b43] hover:bg-[#e8f5e9]"><Camera className="h-5 w-5" /></button>
          <input ref={mediaInputRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/ogg" capture="environment" className="sr-only" aria-label="Choose status image or video" onChange={(event) => { selectMedia(event.target.files?.[0] ?? null); event.currentTarget.value = '' }} />
          <button type="button" onClick={() => { setSearchOpen((open) => !open); setSearch('') }} aria-label="Search statuses" aria-expanded={searchOpen} className="rounded-full p-2 text-slate-600 hover:bg-slate-100"><Search className="h-5 w-5" /></button>
          <div className="relative">
            <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Status options" aria-expanded={menuOpen} className="rounded-full p-2 text-slate-600 hover:bg-slate-100"><MoreVertical className="h-5 w-5" /></button>
            {menuOpen ? <div className="absolute right-0 top-full z-20 w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-lg"><button type="button" onClick={() => { setMenuOpen(false); setLoading(true); void loadStatuses() }} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50">Refresh statuses</button></div> : null}
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto pb-20">
        {searchOpen ? <label className="mx-4 mt-3 flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm"><Search className="h-4 w-4 text-slate-500" /><input aria-label="Search statuses" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people or status text" className="min-w-0 flex-1 bg-transparent outline-none" /></label> : null}
        {error ? <div role="alert" className="m-4 flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => { setLoading(true); void loadStatuses() }} className="shrink-0 font-semibold underline">Retry</button></div> : null}
        <section className="border-b border-slate-100 px-4 py-4">
          <div className="flex items-center justify-between"><h2 className="font-semibold">My status</h2><p className="text-xs text-slate-500">Expires after 24 hours</p></div>
          <div className="mt-4 flex items-center gap-3">
            <button type="button" onClick={openTextComposer} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label="Add a text status">
              <span className="relative"><Avatar src="" alt={user?.name ?? 'Your status'} size="md" /><span className="absolute -bottom-1 -right-1 rounded-full border-2 border-white bg-[#078744] p-0.5 text-white"><Plus className="h-3 w-3" /></span></span>
              <span className="min-w-0"><span className="block text-sm font-semibold">Add status</span><span className="block text-xs text-slate-500">Share a text, photo, or video</span></span>
            </button>
            <button type="button" onClick={openTextComposer} aria-label="Write a text status" title="Text status" className="rounded-full bg-[#e8f5e9] p-2.5 text-[#087b43]"><PencilLine className="h-5 w-5" /></button>
            <button type="button" onClick={() => mediaInputRef.current?.click()} aria-label="Add a photo or video status" title="Photo or video status" className="rounded-full bg-[#e8f5e9] p-2.5 text-[#087b43]"><Camera className="h-5 w-5" /></button>
          </div>
          {showComposer ? <form onSubmit={(event) => { event.preventDefault(); void publish() }} className="mt-4 space-y-3 rounded-xl bg-[#f4f7f4] p-3">
            <label className="block text-xs font-medium text-slate-600">{composerMode === 'text' ? 'Text status' : 'Caption (optional)'}<textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={500} rows={3} placeholder={composerMode === 'text' ? 'Write an update' : 'Add a caption'} className="mt-1 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" /></label>
            {previewUrl ? <div className="relative flex justify-center rounded-xl bg-slate-950 p-2">{file?.type.startsWith('video/') ? <video controls src={previewUrl} className="max-h-64 max-w-full rounded-lg" /> : <img src={previewUrl} alt="Status preview" className="max-h-64 max-w-full rounded-lg object-contain" />}<button type="button" onClick={clearMedia} aria-label="Remove status media" className="absolute right-3 top-3 rounded-full bg-white p-1.5 text-slate-700"><X className="h-4 w-4" /></button></div> : composerMode === 'media' ? <button type="button" onClick={() => mediaInputRef.current?.click()} className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700"><ImagePlus className="h-4 w-4 text-[#087b43]" />Choose an image or video (up to 10 MB)</button> : null}
            <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" type="button" onClick={cancelComposer} disabled={busy}>Cancel</Button><Button variant="primary" size="sm" type="submit" disabled={busy || (!text.trim() && !file)}>{busy ? 'Publishing…' : 'Publish status'}</Button></div>
          </form> : null}
        </section>

        <section className="border-b border-slate-100 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Recent updates</h2><div className="flex gap-1" aria-label="Filter statuses">{([['recent', 'Recent'], ['unviewed', 'Unviewed'], ['viewed', 'Viewed']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? 'bg-[#e8f5e9] text-[#087b43]' : 'text-slate-500 hover:bg-slate-100'}`}>{label}</button>)}</div></div>
          {loading ? <p className="py-5 text-sm text-slate-500" role="status">Loading statuses…</p> : null}
          {!loading && !error && visibleStatuses.length === 0 ? <p className="py-6 text-sm text-slate-500">{statuses.length ? 'No statuses in this filter.' : 'No recent statuses from you or people you follow.'}</p> : null}
          <ul className="mt-3 flex gap-4 overflow-x-auto pb-2">
            {visibleStatuses.map((status) => <li key={status.id} className="w-20 shrink-0"><button type="button" onClick={() => void openStatus(status)} className="flex w-full flex-col items-center gap-2 text-center">
              <span className={`rounded-full p-[3px] ${status.viewedByMe ? 'bg-slate-300' : 'bg-[#078744]'}`}><span className="block rounded-full bg-white p-[2px]"><Avatar src={status.author.avatar} alt={status.author.name} size="md" /></span></span>
              <span className="w-full truncate text-xs font-medium text-slate-700">{status.authorId === user?.id ? 'Your status' : status.author.name}</span>
            </button></li>)}
          </ul>
        </section>

        <section className="px-4 py-4">
          <h2 className="font-semibold">Channels</h2>
          {channelsLoading ? <p className="py-3 text-sm text-slate-500">Loading channels…</p> : null}
          {channelsError ? <p role="alert" className="py-3 text-sm text-rose-700">{channelsError}</p> : null}
          {!channelsLoading && channels.length === 0 && !channelsError ? <p className="py-3 text-sm text-slate-500">You have no channels yet.</p> : null}
          <ul className="mt-2 divide-y divide-slate-100">{channels.map((channel) => <li key={channel.id}><Link to={`/messages?conversationId=${encodeURIComponent(channel.id)}`} className="flex items-center gap-3 py-3 hover:bg-slate-50">
            <Avatar src="" alt={channel.name ?? 'Channel'} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{channel.name ?? 'Channel'}</span>
            <span className="text-xs text-slate-500">{channel.participants.length} followers</span>
          </Link></li>)}</ul>
        </section>
      </main>

      {activeStatus ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label={`${activeStatus.author.name}'s status`}>
        <article className="relative flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-slate-950 text-white">
          <div className="flex items-center justify-between p-3"><div className="flex items-center gap-2"><Avatar src={activeStatus.author.avatar} alt={activeStatus.author.name} size="sm" /><div><p className="text-sm font-semibold">{activeStatus.author.name}</p><time className="text-[11px] text-slate-300">{new Date(activeStatus.createdAt).toLocaleString()}</time></div></div><button type="button" onClick={() => setActiveStatus(null)} aria-label="Close status" className="rounded-full p-2 hover:bg-white/10"><X className="h-5 w-5" /></button></div>
          {activeStatus.mediaUrl ? activeStatus.mediaUrl.match(/\.(mp4|webm|ogg)(?:$|[?#])/i) ? <video controls autoPlay src={resolveMediaUrl(activeStatus.mediaUrl)} crossOrigin={activeStatus.mediaUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} className="max-h-[65dvh] w-full object-contain" /> : <img src={resolveMediaUrl(activeStatus.mediaUrl)} crossOrigin={activeStatus.mediaUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} alt="Status image" className="max-h-[65dvh] w-full object-contain" /> : null}
          {activeStatus.text ? <p className="whitespace-pre-wrap p-4 text-sm">{activeStatus.text}</p> : null}
          {activeStatus.authorId === user?.id ? <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-xs text-slate-300"><span>{activeStatus.viewCount} views</span><button type="button" onClick={() => void deleteStatus(activeStatus)} className="font-semibold text-white">Delete status</button></div> : null}
        </article>
      </div> : null}
    </div>
  )
}
