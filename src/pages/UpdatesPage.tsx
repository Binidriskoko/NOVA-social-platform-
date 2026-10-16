import { useEffect, useMemo, useState } from 'react'
import { ImagePlus, Plus, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest, resolveMediaUrl, uploadMedia } from '../lib/api'

type StoryRecord = {
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

export function UpdatesPage() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [stories, setStories] = useState<StoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showComposer, setShowComposer] = useState(false)
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [activeStory, setActiveStory] = useState<StoryRecord | null>(null)
  const [filter, setFilter] = useState<'recent' | 'unviewed' | 'viewed'>('recent')

  const loadStories = async () => {
    try {
      setError('')
      const response = await apiRequest<{ stories: StoryRecord[] }>('/api/stories')
      setStories(response.stories)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load updates.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadStories() }, [])
  useEffect(() => { if (searchParams.get('create') === '1') setShowComposer(true) }, [searchParams])

  const visibleStories = useMemo(() => stories.filter((story) => filter === 'recent' || (filter === 'viewed' ? story.viewedByMe : !story.viewedByMe)), [filter, stories])

  const publish = async () => {
    if (busy || (!text.trim() && !file)) return
    setBusy(true)
    setError('')
    try {
      const mediaUrl = file ? (await uploadMedia(file)).mediaUrl : ''
      const response = await apiRequest<{ story: StoryRecord }>('/api/stories', {
        method: 'POST',
        body: JSON.stringify({ ...(text.trim() ? { text: text.trim() } : {}), ...(mediaUrl ? { mediaUrl } : {}) }),
      })
      setStories((current) => [...current, response.story])
      setText('')
      setFile(null)
      setShowComposer(false)
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Unable to publish this update.')
    } finally {
      setBusy(false)
    }
  }

  const openStory = async (story: StoryRecord) => {
    try {
      const response = await apiRequest<{ viewed: boolean; viewCount: number }>(`/api/stories/${encodeURIComponent(story.id)}/view`, { method: 'POST' })
      const opened = { ...story, viewedByMe: true, viewCount: response.viewCount }
      setStories((current) => current.map((item) => item.id === story.id ? opened : item))
      setActiveStory(opened)
    } catch (viewError) {
      setError(viewError instanceof Error ? viewError.message : 'Unable to open this update.')
    }
  }

  const deleteStory = async (story: StoryRecord) => {
    try {
      await apiRequest(`/api/stories/${encodeURIComponent(story.id)}`, { method: 'DELETE' })
      setStories((current) => current.filter((item) => item.id !== story.id))
      setActiveStory(null)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this update.')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white text-slate-900">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-100 px-4">
        <div><p className="text-xs font-bold text-slate-900">NOVAKOKO</p><h1 className="text-lg font-semibold">Updates</h1></div>
        <button type="button" onClick={() => setShowComposer((open) => !open)} aria-label="Create status update" aria-expanded={showComposer} className="rounded-full p-2 text-[#087b43] hover:bg-[#e8f5e9]"><Plus className="h-5 w-5" /></button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto pb-20">
        {error ? <div role="alert" className="m-4 flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => void loadStories()} className="shrink-0 font-semibold underline">Retry</button></div> : null}
        <section className="border-b border-slate-100 px-4 py-4">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Status</h2><p className="text-xs text-slate-500">Expires after 24 hours</p></div>
          <button type="button" onClick={() => setShowComposer((open) => !open)} aria-expanded={showComposer} className="mt-4 flex w-full items-center gap-3 text-left">
            <span className="relative"><Avatar src="" alt={user?.name ?? 'Your status'} size="md" /><span className="absolute -bottom-1 -right-1 rounded-full border-2 border-white bg-[#078744] p-0.5 text-white"><Plus className="h-3 w-3" /></span></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">My status</span><span className="block text-xs text-slate-500">Tap to add a status update</span></span>
          </button>
          {showComposer ? <form onSubmit={(event) => { event.preventDefault(); void publish() }} className="mt-4 space-y-3 rounded-xl bg-[#f4f7f4] p-3">
            <label className="block text-xs font-medium text-slate-600">Text status<textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={500} rows={3} placeholder="Write an update" className="mt-1 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900" /></label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700"><ImagePlus className="h-4 w-4 text-[#087b43]" />{file?.name ?? 'Add an image (JPEG, PNG, WebP; up to 10 MB)'}<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={(event) => {
              const selected = event.target.files?.[0] ?? null
              if (selected && selected.size > 10 * 1024 * 1024) { setFile(null); setError('Status images must be 10 MB or smaller.'); return }
              setFile(selected)
              setError('')
            }} /></label>
            <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" type="button" onClick={() => setShowComposer(false)}>Cancel</Button><Button variant="primary" size="sm" type="submit" disabled={busy || (!text.trim() && !file)}>{busy ? 'Posting…' : 'Share status'}</Button></div>
          </form> : null}
        </section>

        <section className="px-4 py-4">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Recent updates</h2><div className="flex gap-1" aria-label="Filter status updates">{([['recent', 'Recent'], ['unviewed', 'Unviewed'], ['viewed', 'Viewed']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? 'bg-[#e8f5e9] text-[#087b43]' : 'text-slate-500 hover:bg-slate-100'}`}>{label}</button>)}</div></div>
          {loading ? <p className="py-5 text-sm text-slate-500" role="status">Loading updates…</p> : null}
          {!loading && !error && visibleStories.length === 0 ? <p className="py-6 text-sm text-slate-500">{stories.length ? 'No updates in this filter.' : 'No recent updates from you or people you follow.'}</p> : null}
          <ul className="mt-2 divide-y divide-slate-100">{visibleStories.map((story) => <li key={story.id}><button type="button" onClick={() => void openStory(story)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-slate-50">
            <span className={`rounded-full p-[3px] ${story.viewedByMe ? 'bg-slate-300' : 'bg-[#078744]'}`}><span className="block rounded-full bg-white p-[2px]"><Avatar src={story.author.avatar} alt={story.author.name} size="sm" /></span></span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{story.authorId === user?.id ? 'Your status' : story.author.name}</span><span className="block truncate text-xs text-slate-500">{story.text || (story.mediaUrl ? 'Photo update' : 'Status update')}</span></span>
            <time className="shrink-0 text-[11px] text-slate-500">{new Date(story.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
          </button></li>)}</ul>
        </section>
      </main>

      {activeStory ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label={`${activeStory.author.name}'s status`}>
        <article className="relative flex max-h-[90dvh] w-full max-w-md flex-col overflow-hidden rounded-xl bg-slate-950 text-white">
          <div className="flex items-center justify-between p-3"><div className="flex items-center gap-2"><Avatar src={activeStory.author.avatar} alt={activeStory.author.name} size="sm" /><div><p className="text-sm font-semibold">{activeStory.author.name}</p><time className="text-[11px] text-slate-300">{new Date(activeStory.createdAt).toLocaleString()}</time></div></div><button type="button" onClick={() => setActiveStory(null)} aria-label="Close status" className="rounded-full p-2 hover:bg-white/10"><X className="h-5 w-5" /></button></div>
          {activeStory.mediaUrl ? <img src={resolveMediaUrl(activeStory.mediaUrl)} crossOrigin={activeStory.mediaUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} alt="Status image" className="max-h-[65dvh] w-full object-contain" /> : null}
          {activeStory.text ? <p className="whitespace-pre-wrap p-4 text-sm">{activeStory.text}</p> : null}
          {activeStory.authorId === user?.id ? <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-xs text-slate-300"><span>{activeStory.viewCount} views</span><button type="button" onClick={() => void deleteStory(activeStory)} className="font-semibold text-white">Delete status</button></div> : null}
        </article>
      </div> : null}
    </div>
  )
}