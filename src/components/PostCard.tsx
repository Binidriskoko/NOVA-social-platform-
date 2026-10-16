import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bookmark, MessageCircle, PencilLine, Share2, ShieldAlert, ThumbsUp, Trash2 } from 'lucide-react'
import { Avatar } from './ui/Avatar'
import { Button } from './ui/Button'
import { PostMedia } from './PostMedia'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'
import { copyTextToClipboard, sharePostLink } from '../lib/postSharing'
import type { Post } from '../types'

type CommentRecord = {
  id: string
  parentId?: string | null
  content: string
  createdAt: string
  author: { id: string; name: string; avatar?: string }
}

type ShareConversation = {
  id: string
  name: string | null
  participants: { userId: string; user?: { name: string } }[]
}

type PostCardProps = {
  post: Post
  onDeleted?: (postId: string) => void
}

export function PostCard({ post, onDeleted }: PostCardProps) {
  const { user } = useAuth()
  const [likes, setLikes] = useState(post.likes)
  const [liked, setLiked] = useState(post.currentUserReaction === 'LIKE')
  const [authorFollowing, setAuthorFollowing] = useState(post.authorFollowing ?? false)
  const [comments, setComments] = useState<CommentRecord[]>([])
  const [commentCount, setCommentCount] = useState(post.comments)
  const [commentDraft, setCommentDraft] = useState('')
  const [replyDraft, setReplyDraft] = useState('')
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [content, setContent] = useState(post.content)
  const [imageUrl, setImageUrl] = useState(post.image ?? '')
  const [visibility, setVisibility] = useState<Post['visibility']>(post.visibility ?? 'PUBLIC')
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(post.savedByCurrentUser ?? false)
  const [saveCount, setSaveCount] = useState(post.saved)
  const [shareCount, setShareCount] = useState(post.shares)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareConversations, setShareConversations] = useState<ShareConversation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const isOwnPost = user?.id === post.author.id

  useEffect(() => {
    setLikes(post.likes)
    setLiked(post.currentUserReaction === 'LIKE')
    setCommentCount(post.comments)
    setAuthorFollowing(post.authorFollowing ?? false)
    setContent(post.content)
    setImageUrl(post.image ?? '')
    setVisibility(post.visibility ?? 'PUBLIC')
    setSaved(post.savedByCurrentUser ?? false)
    setSaveCount(post.saved)
    setShareCount(post.shares)
  }, [post.authorFollowing, post.comments, post.content, post.currentUserReaction, post.image, post.likes, post.saved, post.savedByCurrentUser, post.shares, post.visibility])

  const toggleLike = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = liked
        ? await apiRequest<{ reactionCounts: Record<string, number> }>(`/api/posts/${post.id}/react`, { method: 'DELETE' })
        : await apiRequest<{ reactionCounts: Record<string, number> }>(`/api/posts/${post.id}/react`, {
            method: 'POST',
            body: JSON.stringify({ type: 'LIKE' }),
          })
      setLiked(!liked)
      setLikes(response.reactionCounts.LIKE ?? 0)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update reaction.')
    } finally {
      setBusy(false)
    }
  }

  const loadComments = async () => {
    setCommentsLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ comments: CommentRecord[] }>(`/api/posts/${post.id}/comments`)
      setComments(response.comments)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load comments.')
    } finally {
      setCommentsLoading(false)
    }
  }

  const toggleComments = async () => {
    const nextOpen = !commentsOpen
    setCommentsOpen(nextOpen)
    if (nextOpen) await loadComments()
  }

  const publishComment = async (draft: string, parentId?: string) => {
    if (!draft.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ comment: CommentRecord }>(`/api/posts/${post.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: draft.trim(), ...(parentId ? { parentId } : {}) }),
      })
      setComments((current) => [response.comment, ...current])
      setCommentCount((count) => count + 1)
      if (parentId) {
        setReplyDraft('')
        setReplyToId(null)
      } else {
        setCommentDraft('')
      }
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to publish comment.')
    } finally {
      setBusy(false)
    }
  }

  const submitComment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await publishComment(commentDraft)
  }

  const submitReply = async (event: React.FormEvent<HTMLFormElement>, parentId: string) => {
    event.preventDefault()
    await publishComment(replyDraft, parentId)
  }

  const postUrl = `${window.location.origin}/#post-${encodeURIComponent(post.id)}`

  const recordPostShare = async () => {
    const response = await apiRequest<{ shares: number }>(`/api/posts/${encodeURIComponent(post.id)}/share`, { method: 'POST' })
    setShareCount(response.shares)
  }

  const openShareOptions = async () => {
    if (shareOpen) {
      setShareOpen(false)
      return
    }
    setShareOpen(true)
    if (shareConversations.length) return
    setShareLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ conversations: ShareConversation[] }>('/api/conversations')
      setShareConversations(response.conversations)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load your conversations.')
    } finally {
      setShareLoading(false)
    }
  }

  const copyPostLink = async () => {
    try {
      await copyTextToClipboard(postUrl)
      await recordPostShare()
      setNotice('Post link copied.')
      setShareOpen(false)
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Unable to copy this post link.')
    }
  }

  const shareFromDevice = async () => {
    setShareBusy(true)
    setError('')
    try {
      const result = await sharePostLink({ title: `Post by ${post.author.name}`, text: post.content, url: postUrl })
      if (result === 'cancelled') return
      await recordPostShare()
      setNotice(result === 'copied' ? 'Post link copied.' : 'Post shared.')
      setShareOpen(false)
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Unable to share this post.')
    } finally {
      setShareBusy(false)
    }
  }

  const shareToConversation = async (conversationId: string) => {
    setShareBusy(true)
    setError('')
    try {
      await apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: `Check out this post by ${post.author.name}: ${postUrl}` }),
      })
      await recordPostShare()
      setNotice('Post shared in your conversation.')
      setShareOpen(false)
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : 'Unable to share this post in that conversation.')
    } finally {
      setShareBusy(false)
    }
  }

  const toggleSave = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ saved: boolean; savedCount: number }>(`/api/posts/${post.id}/save`, {
        method: saved ? 'DELETE' : 'POST',
      })
      setSaved(response.saved)
      setSaveCount(response.savedCount)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save this post.')
    } finally {
      setBusy(false)
    }
  }

  const savePostEdits = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ post: { content: string; imageUrl: string | null; visibility: NonNullable<Post['visibility']> } }>(`/api/posts/${post.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: content.trim(), imageUrl: imageUrl.trim(), visibility }),
      })
      setContent(response.post.content)
      setImageUrl(response.post.imageUrl ?? '')
      setVisibility(response.post.visibility)
      setEditing(false)
      setNotice('Post updated.')
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : 'Unable to update this post.')
    } finally {
      setBusy(false)
    }
  }

  const toggleFollowAuthor = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ following: boolean }>(`/api/users/${encodeURIComponent(post.author.id)}/follow`, {
        method: authorFollowing ? 'DELETE' : 'POST',
      })
      setAuthorFollowing(response.following)
      setNotice(response.following ? `Following @${post.author.handle}.` : `Unfollowed @${post.author.handle}.`)
    } catch (followError) {
      setError(followError instanceof Error ? followError.message : 'Unable to update follow status.')
    } finally {
      setBusy(false)
    }
  }

  const reportPost = async () => {
    const reason = window.prompt('Why are you reporting this post?')
    if (!reason || reason.trim().length < 4) return
    setError('')
    try {
      await apiRequest('/api/reports', {
        method: 'POST',
        body: JSON.stringify({ targetType: 'post', targetId: post.id, category: 'OTHER', reason: reason.trim() }),
      })
      setNotice('Report submitted for review.')
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unable to report this post.')
    }
  }

  const deletePost = async () => {
    if (!window.confirm('Delete this post? This cannot be undone.')) return
    setError('')
    try {
      await apiRequest(`/api/posts/${post.id}`, { method: 'DELETE' })
      onDeleted?.(post.id)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this post.')
    }
  }

  return (
    <article id={`post-${post.id}`} className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <Link to={`/profile/${encodeURIComponent(post.author.id)}`} className="flex min-w-0 items-center gap-3">
          <Avatar src={post.author.avatar} alt={post.author.name} size="md" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{post.author.name}</p>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>@{post.author.handle}</span>
              <span aria-hidden="true">·</span>
              <span>{post.time}</span>
            </div>
          </div>
        </Link>
        <div className="flex items-center gap-1">
          {!isOwnPost ? <button type="button" onClick={() => void toggleFollowAuthor()} disabled={busy} aria-label={authorFollowing ? `Unfollow ${post.author.name}` : `Follow ${post.author.name}`} className="rounded-xl px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">{authorFollowing ? 'Following' : 'Follow'}</button> : null}
          <button type="button" onClick={() => void openShareOptions()} aria-label="Share post" title="Share post" className="rounded-full p-2 text-slate-500 hover:bg-slate-100">
            <Share2 className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => void (isOwnPost ? deletePost() : reportPost())} aria-label={isOwnPost ? 'Delete post' : 'Report post'} title={isOwnPost ? 'Delete post' : 'Report post'} className="rounded-full p-2 text-slate-500 hover:bg-slate-100">
            {isOwnPost ? <Trash2 className="h-4 w-4" aria-hidden="true" /> : <ShieldAlert className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {post.category ? <div className="mt-3 inline-flex rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-semibold uppercase text-violet-700">{post.category}</div> : null}
      {editing ? (
        <form onSubmit={(event) => void savePostEdits(event)} className="mt-4 space-y-3">
          <textarea aria-label="Edit post content" value={content} onChange={(event) => setContent(event.target.value)} maxLength={2500} required className="min-h-28 w-full rounded-xl border border-slate-200 p-3 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none" />
          <input type="url" aria-label="Edit image URL" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="Image URL (optional)" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
          <label className="flex items-center justify-between gap-3 text-sm text-slate-600">
            <span>Who can see this post?</span>
            <select aria-label="Post privacy" value={visibility} onChange={(event) => setVisibility(event.target.value as NonNullable<Post['visibility']>)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="PUBLIC">Everyone</option>
              <option value="FOLLOWERS">Followers</option>
              <option value="PRIVATE">Only me</option>
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy || !content.trim()}>{busy ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </form>
      ) : (
        <>
          {content ? <p className="mt-4 whitespace-pre-wrap text-[15px] leading-7 text-slate-700">{content}</p> : null}
          {imageUrl ? <PostMedia url={imageUrl} alt="Post attachment" className="mt-4 max-h-[32rem] w-full rounded-[24px] object-cover" /> : null}
          <p className="mt-2 text-xs text-slate-500">{visibility === 'PUBLIC' ? 'Everyone' : visibility === 'FOLLOWERS' ? 'Followers' : 'Only me'}</p>
        </>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <Button variant="ghost" size="sm" className={`px-2 ${liked ? 'text-indigo-700' : 'text-slate-600'}`} onClick={() => void toggleLike()} disabled={busy} icon={<ThumbsUp className="h-4 w-4" aria-hidden="true" />}>
          {likes}
        </Button>
        <Button variant="ghost" size="sm" className="px-2 text-slate-600" onClick={() => void toggleComments()} icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}>
          {commentCount}
        </Button>
        <Button variant="ghost" size="sm" className={`px-2 ${saved ? 'text-indigo-700' : 'text-slate-600'}`} onClick={() => void toggleSave()} disabled={busy} icon={<Bookmark className="h-4 w-4" aria-hidden="true" />}>
          {saveCount}
        </Button>
        <Button variant="ghost" size="sm" className="px-2 text-slate-600" onClick={() => void openShareOptions()} icon={<Share2 className="h-4 w-4" aria-hidden="true" />}>
          Share · {shareCount}
        </Button>
        {isOwnPost ? <Button variant="ghost" size="sm" className="px-2 text-slate-600" onClick={() => setEditing((value) => !value)} icon={<PencilLine className="h-4 w-4" aria-hidden="true" />}>Edit</Button> : null}
      </div>

      {notice ? <p className="mt-2 text-sm text-emerald-700" role="status">{notice}</p> : null}
      {error ? <p className="mt-2 text-sm text-rose-700" role="alert">{error}</p> : null}
      {shareOpen ? <section aria-label="Share post options" className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void shareFromDevice()} disabled={shareBusy}>{shareBusy ? 'Sharing…' : 'Share from device'}</Button>
          <Button variant="secondary" size="sm" onClick={() => void copyPostLink()} disabled={shareBusy}>Copy link</Button>
        </div>
        <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Send through NOVAKOKO</h3>
        {shareLoading ? <p className="mt-2 text-sm text-slate-500">Loading conversations…</p> : shareConversations.length ? <ul className="mt-1 max-h-40 divide-y divide-slate-200 overflow-y-auto">{shareConversations.map((conversation) => {
          const peer = conversation.participants.find((participant) => participant.userId !== user?.id)?.user?.name
          return <li key={conversation.id} className="flex items-center gap-2 py-2">
            <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{conversation.name ?? peer ?? 'Group conversation'}</span>
            <Button variant="ghost" size="sm" onClick={() => void shareToConversation(conversation.id)} disabled={shareBusy}>Send</Button>
          </li>
        })}</ul> : <p className="mt-2 text-sm text-slate-500">Start a conversation to share this post with NOVAKOKO messaging.</p>}
      </section> : null}

      {commentsOpen ? (
        <section className="mt-4 border-t border-slate-100 pt-4" aria-label="Post comments">
          <form onSubmit={(event) => void submitComment(event)} className="flex gap-2">
            <input aria-label="Write a comment" value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} maxLength={1200} placeholder="Write a comment…" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !commentDraft.trim()}>{busy ? 'Posting…' : 'Comment'}</Button>
          </form>
          {commentsLoading ? <p className="mt-4 text-sm text-slate-500">Loading comments…</p> : comments.length === 0 ? <p className="mt-4 text-sm text-slate-500">No comments yet.</p> : (
            <ul className="mt-4 space-y-3">
              {comments.filter((comment) => !comment.parentId).map((comment) => (
                <li key={comment.id} className="flex gap-2">
                  <Avatar src={comment.author.avatar ?? ''} alt={comment.author.name} size="sm" />
                  <div className="min-w-0 flex-1 rounded-2xl bg-slate-50 px-3 py-2">
                    <p className="text-xs font-semibold text-slate-800">{comment.author.name}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{comment.content}</p>
                    <button type="button" onClick={() => { setReplyToId(replyToId === comment.id ? null : comment.id); setReplyDraft('') }} className="mt-2 text-xs font-semibold text-indigo-700">Reply</button>
                    {comments.filter((reply) => reply.parentId === comment.id).map((reply) => (
                      <div key={reply.id} className="mt-3 border-l-2 border-indigo-100 pl-3">
                        <p className="text-xs font-semibold text-slate-800">{reply.author.name}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{reply.content}</p>
                      </div>
                    ))}
                    {replyToId === comment.id ? (
                      <form onSubmit={(event) => void submitReply(event, comment.id)} className="mt-3 flex gap-2">
                        <input aria-label="Write a reply" value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} maxLength={1200} placeholder="Write a reply…" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
                        <Button type="submit" variant="primary" size="sm" disabled={busy || !replyDraft.trim()}>{busy ? 'Replying…' : 'Reply'}</Button>
                      </form>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </article>
  )
}