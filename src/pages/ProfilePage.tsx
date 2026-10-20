import { Link2, MapPin, PencilLine, UserRoundCheck, UserRoundPlus, UserRoundX } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { PostCard } from '../components/PostCard'
import { useAuth } from '../context/AuthContext'
import { apiRequest, resolveMediaUrl, uploadMedia } from '../lib/api'
import type { Post } from '../types'

type ProfileRecord = {
  id: string
  name: string
  handle: string
  role?: string
  profile: { displayName?: string | null; username?: string | null; bio?: string | null; avatarUrl?: string | null; coverUrl?: string | null; website?: string | null; location?: string | null }
  followerCount: number
  followingCount: number
  relationship?: { isFollowing: boolean; blockedByMe: boolean; blockedMe: boolean }
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
  }
}

export function ProfilePage() {
  const { user } = useAuth()
  const { id } = useParams()
  const profileId = id ?? user?.id
  const isOwnProfile = profileId === user?.id
  const [posts, setPosts] = useState<Post[]>([])
  const [profile, setProfile] = useState<ProfileRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState({ displayName: '', username: '', bio: '', avatarUrl: '', coverUrl: '', website: '', location: '' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const loadProfile = async () => {
    if (!profileId) return
    setLoading(true)
    setError('')
    try {
      const [userResponse, postsResponse] = await Promise.all([
        apiRequest<{ user: ProfileRecord }>(`/api/users/${encodeURIComponent(profileId)}`),
        apiRequest<{ posts: any[] }>('/api/posts?limit=100'),
      ])
      setProfile(userResponse.user)
      setPosts(postsResponse.posts.filter((post) => post.author.id === profileId).map(toPost))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load this profile.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadProfile() }, [profileId])

  const displayName = profile?.profile?.displayName ?? profile?.name ?? 'NOVAKOKO user'
  const avatar = profile?.profile?.avatarUrl ?? ''
  const relationship = profile?.relationship

  const startEditing = () => {
    if (!profile) return
    setEditDraft({
      displayName: profile.profile.displayName ?? profile.name,
      username: profile.profile.username ?? profile.handle,
      bio: profile.profile.bio ?? '',
      avatarUrl: profile.profile.avatarUrl ?? '',
      coverUrl: profile.profile.coverUrl ?? '',
      website: profile.profile.website ?? '',
      location: profile.profile.location ?? '',
    })
    setEditing(true)
  }

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await apiRequest('/api/users/me/profile', { method: 'PUT', body: JSON.stringify(editDraft) })
      setEditing(false)
      await loadProfile()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to update your profile.')
    } finally {
      setBusy(false)
    }
  }

  const uploadProfileImage = async (field: 'avatarUrl' | 'coverUrl', file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const uploaded = await uploadMedia(file)
      setEditDraft((current) => ({ ...current, [field]: uploaded.mediaUrl }))
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Unable to upload this image.')
    } finally {
      setBusy(false)
    }
  }

  const toggleFollow = async () => {
    if (!profile || busy) return
    setBusy(true)
    setError('')
    try {
      const following = relationship?.isFollowing ?? false
      const response = await apiRequest<{ following: boolean; followerCount: number }>(`/api/users/${encodeURIComponent(profile.id)}/follow`, { method: following ? 'DELETE' : 'POST' })
      setProfile((current) => current ? { ...current, followerCount: response.followerCount, relationship: { ...current.relationship, isFollowing: response.following, blockedByMe: false, blockedMe: false } } : current)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update this connection.')
    } finally {
      setBusy(false)
    }
  }

  const toggleBlock = async () => {
    if (!profile || busy) return
    setBusy(true)
    setError('')
    try {
      const blocked = relationship?.blockedByMe ?? false
      await apiRequest(`/api/users/${encodeURIComponent(profile.id)}/block`, { method: blocked ? 'DELETE' : 'POST' })
      setProfile((current) => current ? { ...current, relationship: { ...current.relationship, isFollowing: current.relationship?.isFollowing ?? false, blockedByMe: !blocked, blockedMe: current.relationship?.blockedMe ?? false } } : current)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update block settings.')
    } finally {
      setBusy(false)
    }
  }

  const reportUser = async () => {
    if (!profile) return
    const reason = window.prompt('Why are you reporting this user?')
    if (!reason || reason.trim().length < 4) return
    setError('')
    try {
      await apiRequest('/api/reports', { method: 'POST', body: JSON.stringify({ targetType: 'user', targetId: profile.id, category: 'OTHER', reason: reason.trim() }) })
      setNotice('Report submitted for review.')
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unable to report this user.')
    }
  }

  if (loading) return <div className="p-6 text-sm text-slate-500">Loading profile…</div>
  if (error && !profile) return <div className="m-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">{error}</div>
  if (!profile) return null

  const blockRelationship = Boolean(relationship?.blockedByMe || relationship?.blockedMe)

  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p> : null}
        {notice ? <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700" role="status">{notice}</p> : null}
        <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
          {profile.profile.coverUrl ? <img src={resolveMediaUrl(profile.profile.coverUrl)} crossOrigin={profile.profile.coverUrl.startsWith('/api/media/') ? 'use-credentials' : undefined} alt="Profile cover" className="h-40 w-full object-cover" /> : <div className="h-40 bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500" />}
          <div className="relative p-4 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex items-end gap-4">
                <div className="-mt-14 rounded-full border-4 border-white bg-white p-1"><Avatar src={avatar} alt={displayName} size="xl" /></div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-semibold text-slate-900">{displayName}</h2>
                  </div>
                  <p className="text-sm text-slate-500">@{profile.profile.username ?? profile.handle}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {isOwnProfile ? (
                  <Button variant="secondary" size="sm" onClick={startEditing} icon={<PencilLine className="h-4 w-4" aria-hidden="true" />}>Edit profile</Button>
                ) : (
                  <>
                    <Button variant={relationship?.isFollowing ? 'secondary' : 'primary'} size="sm" disabled={busy || blockRelationship} onClick={() => void toggleFollow()} icon={relationship?.isFollowing ? <UserRoundCheck className="h-4 w-4" aria-hidden="true" /> : <UserRoundPlus className="h-4 w-4" aria-hidden="true" />}>
                      {relationship?.isFollowing ? 'Following' : 'Follow'}
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy || Boolean(relationship?.blockedMe)} onClick={() => void toggleBlock()} icon={<UserRoundX className="h-4 w-4" aria-hidden="true" />}>
                      {relationship?.blockedByMe ? 'Unblock' : relationship?.blockedMe ? 'Blocked you' : 'Block'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void reportUser()}>Report</Button>
                  </>
                )}
              </div>
            </div>

            {editing ? (
              <form onSubmit={(event) => void saveProfile(event)} className="mt-6 grid gap-3 sm:grid-cols-2">
                {([
                  ['displayName', 'Display name'], ['username', 'Username'], ['bio', 'Bio'], ['avatarUrl', 'Avatar image URL'], ['coverUrl', 'Cover image URL'], ['website', 'Website'], ['location', 'Location'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="text-xs font-medium text-slate-600">
                    {label}
                    <input value={editDraft[key]} maxLength={key === 'bio' ? 220 : undefined} onChange={(event) => setEditDraft((current) => ({ ...current, [key]: event.target.value }))} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none" />
                  </label>
                ))}
                <label className="text-xs font-medium text-slate-600">Upload avatar image
                  <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload avatar image" disabled={busy} onChange={(event) => void uploadProfileImage('avatarUrl', event.target.files?.[0])} className="mt-1 block w-full text-sm" />
                </label>
                <label className="text-xs font-medium text-slate-600">Upload cover image
                  <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload cover image" disabled={busy} onChange={(event) => void uploadProfileImage('coverUrl', event.target.files?.[0])} className="mt-1 block w-full text-sm" />
                </label>
                <div className="flex gap-2 sm:col-span-2">
                  <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <>
                <p className="mt-5 max-w-2xl whitespace-pre-wrap text-sm leading-7 text-slate-600">{profile.profile.bio ?? ''}</p>
                <div className="mt-4 flex flex-wrap items-center gap-5 text-sm text-slate-500">
                  {profile.profile.location ? <span className="inline-flex items-center gap-2"><MapPin className="h-4 w-4" aria-hidden="true" /> {profile.profile.location}</span> : null}
                  {profile.profile.website ? <a href={profile.profile.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-indigo-700"><Link2 className="h-4 w-4" aria-hidden="true" /> {profile.profile.website}</a> : null}
                </div>
              </>
            )}

            <div className="mt-5 flex flex-wrap gap-4">
              {[
                { label: 'Posts', value: posts.length },
                { label: 'Followers', value: profile.followerCount },
                { label: 'Following', value: profile.followingCount },
              ].map((stat) => <div key={stat.label} className="rounded-2xl bg-slate-50 px-4 py-3"><p className="text-xl font-semibold text-slate-900">{stat.value}</p><p className="text-xs text-slate-500">{stat.label}</p></div>)}
            </div>
          </div>
        </section>

        <section className="space-y-5" aria-label="Profile posts">
          {posts.length === 0 ? <p className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No posts to show.</p> : posts.map((post) => <PostCard key={post.id} post={post} onDeleted={(postId) => setPosts((current) => current.filter((item) => item.id !== postId))} />)}
        </section>
      </div>
    </div>
  )
}