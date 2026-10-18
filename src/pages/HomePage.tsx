import { ArrowRight, ChevronLeft, ChevronRight, Plus, Send, X } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Fragment, useEffect, useState } from 'react'
import { PostCard } from '../components/PostCard'
import { FeedAdSlot } from '../components/FeedAdSlot'
import { Avatar } from '../components/ui/Avatar'
import { useAuth } from '../context/AuthContext'
import { apiRequest, resolveMediaUrl, uploadMedia } from '../lib/api'
import { isVideoStoryMedia, sendStoryReply } from '../lib/storyReplies'
import type { Post } from '../types'

type StoryRecord = {
  id: string
  authorId: string
  text: string | null
  mediaUrl: string | null
  createdAt: string
  expiresAt: string
  viewCount: number
  viewedByMe: boolean
  author: { id: string; name: string; handle: string; avatar: string }
}

function toPost(record: any): Post {
  return {
    id: record.id,
    author: { id: record.author.id, name: record.author.name, handle: record.author.handle, avatar: record.author.avatar },
    time: new Date(record.createdAt).toLocaleString(),
    content: record.content,
    image: record.imageUrl ?? undefined,
    likes: record.likes ?? 0,
    comments: record.comments ?? 0,
    shares: record.shares ?? 0,
    saved: record.saved ?? 0,
    savedByCurrentUser: record.savedByCurrentUser ?? false,
    visibility: record.visibility ?? 'PUBLIC',
    currentUserReaction: record.currentUserReaction ?? null,
    authorFollowing: record.authorFollowing ?? false,
  }
}

export function HomePage() {
  const { user } = useAuth()
  const [posts, setPosts] = useState<Post[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [stories, setStories] = useState<StoryRecord[]>([])
  const [storiesLoading, setStoriesLoading] = useState(true)
  const [storiesError, setStoriesError] = useState('')
  const [showStoryComposer, setShowStoryComposer] = useState(false)
  const [storyText, setStoryText] = useState('')
  const [storyMediaUrl, setStoryMediaUrl] = useState('')
  const [storyImageFile, setStoryImageFile] = useState<File | null>(null)
  const [uploadedStoryMediaUrl, setUploadedStoryMediaUrl] = useState('')
  const [storyBusy, setStoryBusy] = useState(false)
  const [activeStory, setActiveStory] = useState<StoryRecord | null>(null)
  const [storyProgress, setStoryProgress] = useState(0)
  const [storyReplyDraft, setStoryReplyDraft] = useState('')
  const [storyReplyBusy, setStoryReplyBusy] = useState(false)
  const [storyReplyError, setStoryReplyError] = useState('')
  const [storyReplyNotice, setStoryReplyNotice] = useState('')
  const [storyViewerError, setStoryViewerError] = useState('')
  const navigate = useNavigate()

  const loadFeed = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ posts: any[] }>('/api/posts?limit=50')
      setPosts(response.posts.map(toPost))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load your feed.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadFeed() }, [])

  useEffect(() => {
    if (loading || !window.location.hash.startsWith('#post-')) return
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [loading, posts])

  const loadStories = async () => {
    try {
      const response = await apiRequest<{ stories: StoryRecord[] }>('/api/stories')
      setStories(response.stories)
    } catch (loadError) {
      setStoriesError(loadError instanceof Error ? loadError.message : 'Unable to load stories.')
    } finally {
      setStoriesLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true
    apiRequest<{ stories: StoryRecord[] }>('/api/stories')
      .then((response) => { if (mounted) setStories(response.stories) })
      .catch((loadError) => { if (mounted) setStoriesError(loadError instanceof Error ? loadError.message : 'Unable to load stories.') })
      .finally(() => { if (mounted) setStoriesLoading(false) })
    return () => { mounted = false }
  }, [])

  const refreshStories = () => {
    setStoriesLoading(true)
    setStoriesError('')
    void loadStories()
  }

  const publishStory = async () => {
    if (storyBusy || (!storyText.trim() && !storyMediaUrl.trim() && !storyImageFile)) return
    setStoryBusy(true)
    setStoriesError('')
    try {
      const mediaUrl = storyImageFile
        ? uploadedStoryMediaUrl || (await uploadMedia(storyImageFile)).mediaUrl
        : storyMediaUrl.trim()
      if (storyImageFile && mediaUrl !== uploadedStoryMediaUrl) setUploadedStoryMediaUrl(mediaUrl)
      const response = await apiRequest<{ story: StoryRecord }>('/api/stories', {
        method: 'POST',
        body: JSON.stringify({ ...(storyText.trim() ? { text: storyText.trim() } : {}), ...(mediaUrl ? { mediaUrl } : {}) }),
      })
      setStories((current) => [...current, response.story])
      setStoryText('')
      setStoryMediaUrl('')
      setStoryImageFile(null)
      setUploadedStoryMediaUrl('')
      setShowStoryComposer(false)
    } catch (publishError) {
      setStoriesError(publishError instanceof Error ? publishError.message : 'Unable to publish this story.')
    } finally {
      setStoryBusy(false)
    }
  }

  const openStory = async (story: StoryRecord) => {
    setStoryViewerError('')
    try {
      const response = await apiRequest<{ viewed: boolean; viewCount: number }>(`/api/stories/${encodeURIComponent(story.id)}/view`, { method: 'POST' })
      const updatedStory = { ...story, viewedByMe: true, viewCount: response.viewCount }
      setStories((current) => current.map((item) => item.id === story.id ? updatedStory : item))
      setStoryProgress(0)
      setActiveStory(updatedStory)
    } catch (viewError) {
      const message = viewError instanceof Error ? viewError.message : 'Unable to open this story.'
      setStoriesError(message)
      setStoryViewerError(message)
    }
  }

  const closeStory = () => {
    setActiveStory(null)
    setStoryProgress(0)
    setStoryReplyDraft('')
    setStoryReplyError('')
    setStoryReplyNotice('')
    setStoryViewerError('')
  }

  const stepStory = (direction: -1 | 1) => {
    if (!activeStory) return
    const currentIndex = stories.findIndex((story) => story.id === activeStory.id)
    const nextStory = stories[currentIndex + direction]
    if (nextStory) void openStory(nextStory)
  }

  const submitStoryReply = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!activeStory || storyReplyBusy || !storyReplyDraft.trim()) return
    setStoryReplyBusy(true)
    setStoryReplyError('')
    setStoryReplyNotice('')
    try {
      await sendStoryReply(activeStory.authorId, storyReplyDraft, apiRequest)
      setStoryReplyDraft('')
      setStoryReplyNotice('Reply sent to your conversation.')
    } catch (replyError) {
      setStoryReplyError(replyError instanceof Error ? replyError.message : 'Unable to send your story reply.')
    } finally {
      setStoryReplyBusy(false)
    }
  }

  useEffect(() => {
    if (!activeStory || isVideoStoryMedia(activeStory.mediaUrl)) return
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      setStoryProgress(Math.min(100, ((Date.now() - startedAt) / 7000) * 100))
    }, 100)
    return () => window.clearInterval(timer)
  }, [activeStory])

  const deleteStory = async (story: StoryRecord) => {
    try {
      await apiRequest(`/api/stories/${encodeURIComponent(story.id)}`, { method: 'DELETE' })
      setStories((current) => current.filter((item) => item.id !== story.id))
      setActiveStory(null)
    } catch (deleteError) {
      setStoriesError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this story.')
    }
  }

  return (
    <div className="min-h-[calc(100dvh-1px)] w-full bg-slate-100">
      <div className="mx-auto w-full max-w-7xl px-2 py-3 sm:px-4 lg:px-6">
        {/* Facebook-style quick navigation */}
        <div className="mb-3 flex w-full gap-2 overflow-x-auto pb-1">
          <Link to="/" className="shrink-0 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
            Home
          </Link>
          <Link to="/explore" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Explore
          </Link>
          <Link to="/messages" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Messages
          </Link>
          <Link to="/videos" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Videos
          </Link>
          <Link to="/communities?type=GROUP" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Groups
          </Link>
          <Link to="/communities?type=CHANNEL" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Channels
          </Link>
          <Link to="/calls" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Calls
          </Link>
          <Link to="/notifications" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Notifications
          </Link>
        </div>

        <section className="mb-3 overflow-hidden rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-slate-900">Stories</h2>
              <p className="text-xs text-slate-500">Share a moment with your community</p>
            </div>
            <p className="text-xs text-slate-500">Stories expire after 24 hours</p>
          </div>

          <div className="flex gap-3 overflow-x-auto pb-1">
            <button type="button" onClick={() => setShowStoryComposer((current) => !current)} aria-expanded={showStoryComposer} className="flex h-28 w-20 shrink-0 flex-col items-center justify-center rounded-2xl bg-gradient-to-b from-blue-600 to-indigo-700 text-center text-white">
              <Plus className="h-6 w-6" aria-hidden="true" />
              <span className="mt-2 text-xs font-semibold">Add story</span>
            </button>
            {stories.map((story) => (
              <button key={story.id} type="button" onClick={() => void openStory(story)} className={`relative flex h-28 w-20 shrink-0 flex-col justify-end overflow-hidden rounded-2xl p-2 text-left text-white ring-2 ${story.viewedByMe ? 'ring-slate-200' : 'ring-indigo-500'}`}>
                {story.mediaUrl ? <img src={resolveMediaUrl(story.mediaUrl)} crossOrigin={story.mediaUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <span className="absolute inset-0 bg-gradient-to-b from-indigo-500 to-blue-800" />}
                <span className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                <span className="absolute left-2 top-2 rounded-full border-2 border-white"><Avatar src={story.author.avatar} alt={story.author.name} size="sm" /></span>
                <span className="relative line-clamp-2 text-xs font-semibold">{story.authorId === user?.id ? 'Your story' : story.author.name}</span>
              </button>
            ))}
          </div>
          {storiesLoading ? <p className="mt-2 text-xs text-slate-500">Loading stories…</p> : null}
          {storiesError ? <p role="alert" className="mt-2 flex items-center justify-between gap-2 text-xs text-rose-700"><span>{storiesError}</span><button type="button" onClick={refreshStories} className="shrink-0 font-semibold underline">Retry</button></p> : null}
          {!storiesLoading && !storiesError && stories.length === 0 ? <p className="mt-2 text-xs text-slate-500">No active stories from you or people you follow.</p> : null}
          {showStoryComposer ? <form onSubmit={(event) => { event.preventDefault(); void publishStory() }} className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-[1fr_1fr_auto]">
            <input aria-label="Story text" value={storyText} onChange={(event) => setStoryText(event.target.value)} maxLength={500} placeholder="Share a short status" className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            <label className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-600">
              <span className="block">Story image (JPEG, PNG, WebP; up to 10 MB)</span>
              <input aria-label="Upload story image" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { setStoryImageFile(event.target.files?.[0] ?? null); setUploadedStoryMediaUrl(''); setStoryMediaUrl('') }} className="mt-1 block w-full text-xs" />
            </label>
            <input aria-label="Story image URL" type="url" value={storyMediaUrl} onChange={(event) => { setStoryMediaUrl(event.target.value); setStoryImageFile(null); setUploadedStoryMediaUrl('') }} placeholder="Or image URL (HTTPS)" className="min-w-0 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            <button type="submit" disabled={storyBusy || (!storyText.trim() && !storyMediaUrl.trim() && !storyImageFile)} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{storyBusy ? 'Posting…' : 'Post status'}</button>
          </form> : null}
        </section>

        {activeStory ? <div className="fixed inset-0 z-50 flex h-[100dvh] items-center justify-center bg-black text-white" role="dialog" aria-modal="true" aria-label={`${activeStory.author.name}'s story`}>
          <section className="relative flex h-full w-full max-w-lg flex-col overflow-hidden bg-slate-950 pt-[env(safe-area-inset-top,1rem)] pb-[env(safe-area-inset-bottom,1rem)] sm:max-h-[94dvh] sm:rounded-2xl">
            <div className="absolute inset-0">
              {activeStory.mediaUrl && isVideoStoryMedia(activeStory.mediaUrl)
                ? <video key={activeStory.id} src={resolveMediaUrl(activeStory.mediaUrl)} crossOrigin={activeStory.mediaUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} autoPlay muted playsInline controls onTimeUpdate={(event) => {
                  const video = event.currentTarget
                  if (video.duration) setStoryProgress(video.currentTime / video.duration * 100)
                }} onEnded={() => stepStory(1)} className="h-full w-full object-cover" />
                : activeStory.mediaUrl
                  ? <img src={resolveMediaUrl(activeStory.mediaUrl)} crossOrigin={activeStory.mediaUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} alt="" className="h-full w-full object-cover" />
                  : <div className="h-full w-full bg-gradient-to-br from-indigo-600 via-blue-800 to-slate-950" />}
              <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/75" />
            </div>
            <div className="relative z-10 flex min-h-0 flex-1 flex-col px-4">
              <div className="flex gap-1 pt-3" aria-label="Story progress">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/35"><div className="h-full bg-white transition-[width] duration-100" style={{ width: `${storyProgress}%` }} /></div>
              </div>
              <header className="mt-3 flex items-center gap-3">
                <Avatar src={activeStory.author.avatar} alt={activeStory.author.name} size="sm" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{activeStory.author.name}</p><p className="text-xs text-white/75">{new Date(activeStory.createdAt).toLocaleString()}</p></div>
                {activeStory.authorId === user?.id ? <button type="button" onClick={() => void deleteStory(activeStory)} className="rounded-lg px-2 py-2 text-xs font-semibold hover:bg-white/15">Delete</button> : null}
                <button type="button" onClick={closeStory} aria-label="Close story" className="rounded-full p-2 hover:bg-white/15"><X className="h-5 w-5" aria-hidden="true" /></button>
              </header>
              {storyViewerError ? <p role="alert" className="mt-3 rounded-lg bg-rose-950/75 px-3 py-2 text-center text-xs text-rose-100">{storyViewerError}</p> : null}
              <div className="my-auto flex items-center justify-between gap-3">
                <button type="button" onClick={() => stepStory(-1)} disabled={stories.findIndex((story) => story.id === activeStory.id) <= 0} aria-label="Previous story" className="rounded-full bg-black/35 p-2 disabled:invisible"><ChevronLeft className="h-6 w-6" aria-hidden="true" /></button>
                <div className="max-h-[55dvh] min-w-0 flex-1 overflow-y-auto text-center">
                  {activeStory.text ? <p className="whitespace-pre-wrap break-words text-lg font-medium drop-shadow sm:text-xl">{activeStory.text}</p> : null}
                  {activeStory.authorId === user?.id ? <p className="mt-3 text-xs text-white/80">{activeStory.viewCount} views</p> : null}
                </div>
                <button type="button" onClick={() => stepStory(1)} disabled={stories.findIndex((story) => story.id === activeStory.id) >= stories.length - 1} aria-label="Next story" className="rounded-full bg-black/35 p-2 disabled:invisible"><ChevronRight className="h-6 w-6" aria-hidden="true" /></button>
              </div>
              {activeStory.authorId !== user?.id ? <div className="mt-auto pb-4">
                {storyReplyNotice ? <p className="mb-2 text-center text-sm text-emerald-200" role="status">{storyReplyNotice}</p> : null}
                {storyReplyError ? <p className="mb-2 text-center text-sm text-rose-200" role="alert">{storyReplyError}</p> : null}
                <form onSubmit={(event) => void submitStoryReply(event)} className="flex items-center gap-2 rounded-full border border-white/40 bg-black/40 p-1.5 pl-4 backdrop-blur">
                  <input aria-label={`Reply to ${activeStory.author.name}'s story`} value={storyReplyDraft} onChange={(event) => setStoryReplyDraft(event.target.value)} maxLength={1000} placeholder="Reply to story…" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-white outline-none placeholder:text-white/70" />
                  <button type="submit" aria-label="Send story reply" disabled={storyReplyBusy || !storyReplyDraft.trim()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white disabled:opacity-50"><Send className="h-4 w-4" aria-hidden="true" /></button>
                </form>
                {storyReplyBusy ? <p className="mt-2 text-center text-xs text-white/80">Sending reply…</p> : null}
              </div> : null}
            </div>
          </section>
        </div> : null}

        <div className="grid w-full gap-4 lg:grid-cols-[240px_minmax(0,1fr)_260px]">
          {/* Left Facebook-style shortcuts */}
          <aside className="hidden lg:block">
            <div className="sticky top-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
              <h3 className="mb-3 px-2 text-sm font-bold text-slate-900">Shortcuts</h3>

              <div className="space-y-1">
                <Link to="/profile" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  My Profile
                </Link>
                <Link to="/explore" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Find People
                </Link>
                <Link to="/communities?type=GROUP" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Groups
                </Link>
                <Link to="/communities?type=COMMUNITY" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Communities
                </Link>
                <Link to="/communities?type=CHANNEL" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Channels
                </Link>
                <Link to="/calls" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Calls
                </Link>
                <Link to="/notifications" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Notifications
                </Link>
              </div>
            </div>
          </aside>

          {/* Main feed */}
          <main className="min-w-0">
            <div className="mb-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => navigate('/create')}
                  className="flex min-w-0 flex-1 items-center rounded-full bg-slate-100 px-4 py-3 text-left text-sm text-slate-500 hover:bg-slate-200"
                >
                  What&apos;s on your mind?
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/create')}
                  className="hidden shrink-0 rounded-full bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white sm:inline-flex"
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                  Post
                </button>
              </div>

              <div className="mt-3 grid grid-cols-3 border-t border-slate-100 pt-3">
                <button type="button" onClick={() => navigate('/create')} className="py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  Photo / Video
                </button>
                <Link to="/live" className="py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  Live
                </Link>
                <button type="button" onClick={() => navigate('/create')} className="py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  Create Post
                </button>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between">
              <div>
                <h1 className="text-lg font-bold text-slate-900">Your Feed</h1>
                <p className="text-xs text-slate-500">Posts from people and communities you follow</p>
              </div>
              <button
                type="button"
                onClick={() => void loadFeed()}
                disabled={loading}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-blue-50 disabled:opacity-50"
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {error ? (
              <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>{error}</span>
                  <button type="button" onClick={() => void loadFeed()} className="font-semibold underline">
                    Retry
                  </button>
                </div>
              </div>
            ) : null}

            {loading ? (
              <div className="space-y-3" aria-live="polite" aria-label="Loading your feed">
                {[0, 1].map((item) => (
                  <div key={item} className="animate-pulse rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                    <div className="flex items-center gap-3">
                      <span className="h-10 w-10 rounded-full bg-slate-200" />
                      <span className="space-y-2"><span className="block h-3 w-32 rounded bg-slate-200" /><span className="block h-2 w-20 rounded bg-slate-100" /></span>
                    </div>
                    <span className="mt-4 block h-3 w-full rounded bg-slate-100" />
                    <span className="mt-2 block h-3 w-3/4 rounded bg-slate-100" />
                  </div>
                ))}
              </div>
            ) : null}

            {!loading && !error && posts.length === 0 ? (
              <div className="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
                <p className="font-semibold text-slate-800">Your feed starts here</p>
                <p className="mt-1 text-sm text-slate-500">Create your first post or discover people to follow.</p>
                <button type="button" onClick={() => navigate('/create')} className="mt-4 inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
                  Create a post
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ) : null}

            <div className="space-y-3">
              {!loading && posts.map((post, index) => (
                <Fragment key={post.id}>
                  <PostCard post={post} onDeleted={(postId) => setPosts((current) => current.filter((item) => item.id !== postId))} />
                  {index === Math.min(3, posts.length - 1) ? <FeedAdSlot /> : null}
                </Fragment>
              ))}
            </div>
          </main>

          {/* Right discovery panel */}
          <aside className="hidden lg:block">
            <div className="sticky top-3 space-y-3">
              <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <h3 className="font-bold text-slate-900">Discover</h3>
                <div className="mt-3 space-y-2">
                  <Link to="/explore" className="block rounded-xl bg-slate-50 p-3 hover:bg-blue-50">
                    <p className="text-sm font-semibold text-blue-700">Explore people</p>
                    <p className="mt-1 text-xs text-slate-500">Find people and creators to follow.</p>
                  </Link>
                  <Link to="/communities?type=GROUP" className="block rounded-xl bg-slate-50 p-3 hover:bg-blue-50">
                    <p className="text-sm font-semibold text-blue-700">Groups</p>
                    <p className="mt-1 text-xs text-slate-500">Join conversations around shared interests.</p>
                  </Link>
                  <Link to="/live" className="block rounded-xl bg-slate-50 p-3 hover:bg-blue-50">
                    <p className="text-sm font-semibold text-blue-700">Live</p>
                    <p className="mt-1 text-xs text-slate-500">Discover live conversations and broadcasts.</p>
                  </Link>
                </div>
              </div>

              <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <h3 className="font-bold text-slate-900">NOVAKOKO</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Connect • Chat • Share • Live • Grow
                </p>
                <Link to="/explore" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                  Explore NOVAKOKO
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
