import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, Heart, MessageCircle, Share2, X } from 'lucide-react'
import { PostMedia } from '../components/PostMedia'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { ApiError, apiRequest } from '../lib/api'
import { isVideoPostMediaUrl } from '../lib/postMedia'
import { sharePostLink } from '../lib/postSharing'
import { useAuth } from '../context/AuthContext'
import { clearCachedRead, getCachedRead, setCachedRead } from '../lib/readCache'
import type { Post } from '../types'

type FeedPostRecord = {
  id: string
  author: Post['author']
  createdAt: string
  content: string
  imageUrl: string | null
  likes: number
  comments: number
  shares: number
  saved: number
  savedByCurrentUser?: boolean
  visibility?: Post['visibility']
  currentUserReaction?: string | null
}

type VideoComment = {
  id: string
  content: string
  createdAt: string
  author: { id: string; name: string; avatar?: string }
}

function toPost(record: FeedPostRecord): Post {
  return {
    id: record.id,
    author: record.author,
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
  }
}

export function VideosPage() {
  const { user } = useAuth()
  const feedCacheKey = user?.id ? JSON.stringify(['feed', user.id]) : ''
  const cachedFeed = feedCacheKey ? getCachedRead<Post[]>(feedCacheKey) : undefined
  const [posts, setPosts] = useState<Post[]>(() => cachedFeed?.filter((post) => Boolean(post.image && isVideoPostMediaUrl(post.image))) ?? [])
  const [loading, setLoading] = useState(!cachedFeed)
  const [feedStale, setFeedStale] = useState(Boolean(cachedFeed))
  const [error, setError] = useState('')
  const feedRequestRef = useRef<{ key: string; controller: AbortController } | null>(null)
  const feedCacheKeyRef = useRef(feedCacheKey)
  feedCacheKeyRef.current = feedCacheKey
  const [activePostId, setActivePostId] = useState('')
  const [commentsPost, setCommentsPost] = useState<Post | null>(null)
  const [comments, setComments] = useState<VideoComment[]>([])
  const [commentDraft, setCommentDraft] = useState('')
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const feedRef = useRef<HTMLDivElement | null>(null)

  const loadVideos = useCallback(async () => {
    if (feedRequestRef.current?.key === feedCacheKey) return
    feedRequestRef.current?.controller.abort()
    const controller = new AbortController()
    const request = { key: feedCacheKey, controller }
    feedRequestRef.current = request
    if (!feedCacheKey || !getCachedRead<Post[]>(feedCacheKey)) setLoading(true)
    setError('')
    try {
      const { posts: records } = await apiRequest<{ posts: FeedPostRecord[] }>('/api/posts?limit=50', { signal: controller.signal })
      if (feedCacheKeyRef.current !== feedCacheKey) return
      const nextFeed = records.map(toPost)
      const videos = nextFeed.filter((post) => Boolean(post.image && isVideoPostMediaUrl(post.image)))
      if (feedCacheKey) setCachedRead(feedCacheKey, nextFeed)
      setPosts(videos)
      setActivePostId(videos[0]?.id ?? '')
      setFeedStale(false)
    } catch (loadError) {
      if (controller.signal.aborted || feedCacheKeyRef.current !== feedCacheKey) return
      const savedFeed = feedCacheKey ? getCachedRead<Post[]>(feedCacheKey) : undefined
      if (loadError instanceof ApiError && [401, 403].includes(loadError.status ?? 0)) {
        if (feedCacheKey) clearCachedRead(feedCacheKey)
        setPosts([])
        setFeedStale(false)
      } else if (loadError instanceof ApiError
        && (loadError.code === 'NETWORK_ERROR' || loadError.code === 'TIMEOUT')
        && savedFeed) {
        const savedVideos = savedFeed.filter((post) => Boolean(post.image && isVideoPostMediaUrl(post.image)))
        setPosts(savedVideos)
        setActivePostId(savedVideos[0]?.id ?? '')
        setFeedStale(true)
        setError('Connection unavailable. Showing saved videos, which may be out of date.')
      } else {
        setFeedStale(Boolean(savedFeed))
        setError(savedFeed
          ? `Unable to refresh. Showing saved videos, which may be out of date. ${loadError instanceof Error ? loadError.message : 'Unable to load videos.'}`
          : loadError instanceof Error ? loadError.message : 'Unable to load videos.')
      }
    } finally {
      if (feedRequestRef.current === request) {
        setLoading(false)
        feedRequestRef.current = null
      }
    }
  }, [feedCacheKey])

  useEffect(() => {
    const savedFeed = feedCacheKey ? getCachedRead<Post[]>(feedCacheKey) : undefined
    const savedVideos = savedFeed?.filter((post) => Boolean(post.image && isVideoPostMediaUrl(post.image))) ?? []
    setPosts(savedVideos)
    setActivePostId(savedVideos[0]?.id ?? '')
    setFeedStale(Boolean(savedFeed))
    setLoading(!savedFeed)
    void loadVideos()
  }, [feedCacheKey, loadVideos])

  useEffect(() => {
    const root = feedRef.current
    if (!root) return
    const observer = new IntersectionObserver((entries) => {
      const active = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]
      const id = active?.target.getAttribute('data-post-id')
      if (id) setActivePostId(id)
    }, { root, threshold: [0.35, 0.65, 0.9] })
    root.querySelectorAll('[data-post-id]').forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [posts])

  const updatePost = (id: string, update: (post: Post) => Post) => {
    setPosts((current) => current.map((post) => post.id === id ? update(post) : post))
  }

  const toggleLike = async (post: Post) => {
    setActionError('')
    try {
      const liked = post.currentUserReaction === 'LIKE'
      const response = await apiRequest<{ reactionCounts: Record<string, number> }>(`/api/posts/${encodeURIComponent(post.id)}/react`, {
        method: liked ? 'DELETE' : 'POST',
        ...(!liked ? { body: JSON.stringify({ type: 'LIKE' }) } : {}),
      })
      updatePost(post.id, (current) => ({
        ...current,
        likes: response.reactionCounts.LIKE ?? current.likes,
        currentUserReaction: liked ? null : 'LIKE',
      }))
    } catch (likeError) {
      setActionError(likeError instanceof Error ? likeError.message : 'Unable to update this reaction.')
    }
  }

  const toggleBookmark = async (post: Post) => {
    setActionError('')
    try {
      const response = await apiRequest<{ saved: boolean; savedCount: number }>(`/api/posts/${encodeURIComponent(post.id)}/save`, {
        method: post.savedByCurrentUser ? 'DELETE' : 'POST',
      })
      updatePost(post.id, (current) => ({ ...current, savedByCurrentUser: response.saved, saved: response.savedCount }))
    } catch (saveError) {
      setActionError(saveError instanceof Error ? saveError.message : 'Unable to update this bookmark.')
    }
  }

  const sharePost = async (post: Post) => {
    setActionError('')
    setNotice('')
    try {
      const url = `${window.location.origin}/#post-${encodeURIComponent(post.id)}`
      const result = await sharePostLink({ title: `Post by ${post.author.name}`, text: post.content, url })
      if (result === 'cancelled') return
      setNotice(result === 'copied' ? 'Post link copied.' : 'Post shared.')
      const response = await apiRequest<{ shares: number }>(`/api/posts/${encodeURIComponent(post.id)}/share`, { method: 'POST' })
      updatePost(post.id, (current) => ({ ...current, shares: response.shares }))
    } catch (shareError) {
      setActionError(shareError instanceof Error ? shareError.message : 'Unable to share this post.')
    }
  }

  const openComments = async (post: Post) => {
    setCommentsPost(post)
    setComments([])
    setCommentDraft('')
    setCommentsLoading(true)
    setActionError('')
    try {
      const response = await apiRequest<{ comments: VideoComment[] }>(`/api/posts/${encodeURIComponent(post.id)}/comments`)
      setComments(response.comments)
    } catch (loadError) {
      setActionError(loadError instanceof Error ? loadError.message : 'Unable to load comments.')
    } finally {
      setCommentsLoading(false)
    }
  }

  const publishComment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!commentsPost || !commentDraft.trim()) return
    setActionError('')
    try {
      const response = await apiRequest<{ comment: VideoComment }>(`/api/posts/${encodeURIComponent(commentsPost.id)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: commentDraft.trim() }),
      })
      setComments((current) => [response.comment, ...current])
      updatePost(commentsPost.id, (current) => ({ ...current, comments: current.comments + 1 }))
      setCommentDraft('')
    } catch (commentError) {
      setActionError(commentError instanceof Error ? commentError.message : 'Unable to publish this comment.')
    }
  }

  return (
    <main className="relative h-full min-h-0 bg-black text-white" aria-label="Videos">
      <h1 className="sr-only">Videos feed</h1>
      <div ref={feedRef} className="h-full min-h-0 snap-y snap-mandatory overflow-y-auto overscroll-contain scroll-smooth">
        {loading ? <div className="flex h-full items-center justify-center text-sm text-white/70" role="status">Loading videos…</div> : null}
        {error ? <div className={`flex ${feedStale && posts.length ? 'items-center justify-between gap-3 px-4 py-3 text-left' : 'h-full flex-col items-center justify-center gap-3 px-6 text-center'} ${feedStale && posts.length ? 'bg-amber-950 text-amber-100' : ''}`} role={feedStale && posts.length ? 'status' : 'alert'}><p>{error}</p><button type="button" onClick={() => void loadVideos()} disabled={loading} className="shrink-0 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold disabled:opacity-50">{loading ? 'Retrying…' : 'Retry'}</button></div> : null}
        {!loading && !error && posts.length === 0 ? <div className="flex h-full flex-col items-center justify-center px-6 text-center"><p className="font-semibold">No videos yet</p><p className="mt-2 text-sm text-white/70">Video posts will appear here. Share a video from Home to get started.</p></div> : null}
        {!loading && (!error || feedStale) ? posts.map((post) => (
          <section
            key={post.id}
            data-post-id={post.id}
            className="relative flex h-full snap-start items-center justify-center overflow-hidden bg-black pb-16 sm:pb-4"
          >
            {post.image ? <PostMedia url={post.image} postId={post.id} measurementSource="videos" active={activePostId === post.id} className="h-full max-h-full w-full max-w-full object-contain" alt={`Video by ${post.author.name}`} /> : null}
            <div className="pointer-events-none absolute inset-x-0 bottom-20 bg-gradient-to-t from-black/75 via-black/25 to-transparent px-4 pb-5 pt-20 sm:bottom-4 sm:pb-5">
              <div className="pointer-events-auto flex max-w-[75%] items-center gap-2">
                <Avatar src={post.author.avatar} alt={post.author.name} size="sm" />
                <span className="truncate text-sm font-semibold">{post.author.name}</span>
                <span className="truncate text-xs text-white/70">@{post.author.handle}</span>
              </div>
              {post.content ? <p className="pointer-events-auto mt-2 max-w-[78%] whitespace-pre-wrap text-sm leading-5">{post.content}</p> : null}
            </div>
            <div className="absolute bottom-28 right-3 z-10 flex flex-col items-center gap-4 sm:bottom-8 sm:right-5">
              <button type="button" onClick={() => void toggleLike(post)} aria-label={`${post.currentUserReaction === 'LIKE' ? 'Unlike' : 'Like'} video`} aria-pressed={post.currentUserReaction === 'LIKE'} className="flex flex-col items-center gap-1 text-xs drop-shadow">
                <span className={`rounded-full bg-black/45 p-3 ${post.currentUserReaction === 'LIKE' ? 'text-pink-400' : 'text-white'}`}><Heart className={`h-6 w-6 ${post.currentUserReaction === 'LIKE' ? 'fill-current' : ''}`} aria-hidden="true" /></span>{post.likes}
              </button>
              <button type="button" onClick={() => void openComments(post)} aria-label="Comment on video" className="flex flex-col items-center gap-1 text-xs drop-shadow">
                <span className="rounded-full bg-black/45 p-3 text-white"><MessageCircle className="h-6 w-6" aria-hidden="true" /></span>{post.comments}
              </button>
              <button type="button" onClick={() => void toggleBookmark(post)} aria-label={post.savedByCurrentUser ? 'Remove video bookmark' : 'Bookmark video'} aria-pressed={post.savedByCurrentUser} className="flex flex-col items-center gap-1 text-xs drop-shadow">
                <span className={`rounded-full bg-black/45 p-3 ${post.savedByCurrentUser ? 'text-amber-300' : 'text-white'}`}><Bookmark className={`h-6 w-6 ${post.savedByCurrentUser ? 'fill-current' : ''}`} aria-hidden="true" /></span>{post.saved}
              </button>
              <button type="button" onClick={() => void sharePost(post)} aria-label="Share video" className="flex flex-col items-center gap-1 text-xs drop-shadow">
                <span className="rounded-full bg-black/45 p-3 text-white"><Share2 className="h-6 w-6" aria-hidden="true" /></span>{post.shares}
              </button>
            </div>
          </section>
        )) : null}
      </div>
      {actionError ? <p role="alert" className="absolute left-3 top-3 z-20 max-w-[75%] rounded-xl bg-rose-900/90 px-3 py-2 text-xs text-white">{actionError}</p> : null}
      {notice ? <p role="status" className="absolute left-3 top-3 z-20 max-w-[75%] rounded-xl bg-emerald-900/90 px-3 py-2 text-xs text-white">{notice}</p> : null}
      {commentsPost ? <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="video-comments-title">
        <section className="flex max-h-[80dvh] w-full max-w-lg flex-col rounded-t-3xl bg-white p-4 text-slate-900 sm:rounded-3xl">
          <header className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 id="video-comments-title" className="font-semibold">Comments</h2>
            <button type="button" onClick={() => setCommentsPost(null)} aria-label="Close comments" className="rounded-full p-2 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" aria-hidden="true" /></button>
          </header>
          {actionError ? <p role="alert" className="mt-2 text-sm text-rose-700">{actionError}</p> : null}
          <div className="min-h-24 flex-1 overflow-y-auto py-3">
            {commentsLoading ? <p className="text-sm text-slate-500" role="status">Loading comments…</p> : comments.length ? <ul className="space-y-3">{comments.map((comment) => <li key={comment.id} className="flex gap-2"><Avatar src={comment.author.avatar ?? ''} alt={comment.author.name} size="sm" /><div><p className="text-xs font-semibold">{comment.author.name}</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{comment.content}</p></div></li>)}</ul> : <p className="text-sm text-slate-500">No comments yet.</p>}
          </div>
          <form onSubmit={(event) => void publishComment(event)} className="flex gap-2 border-t border-slate-100 pt-3">
            <input aria-label="Write a comment" value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} maxLength={1200} placeholder="Write a comment…" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
            <Button type="submit" variant="primary" size="sm" disabled={!commentDraft.trim()}>Comment</Button>
          </form>
        </section>
      </div> : null}
    </main>
  )
}
