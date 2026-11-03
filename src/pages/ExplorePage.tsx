import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, UserRoundPlus, UserRoundCheck } from 'lucide-react'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'

type DirectoryUser = {
  id: string
  name: string
  handle: string
  avatar: string
  profile?: { bio?: string | null }
  followerCount: number
  relationship?: { isFollowing: boolean; blockedByMe: boolean; blockedMe: boolean }
}

export function ExplorePage() {
  const { user } = useAuth()
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [term, setTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  const loadUsers = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ users: DirectoryUser[] }>('/api/users')
      const nextUsers = response.users.filter((directoryUser) => directoryUser.id !== user?.id)
      setUsers(nextUsers)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to search users.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!user?.id) {
      setUsers([])
      setLoading(true)
      return
    }
    void loadUsers()
  }, [user?.id])

  const filteredUsers = useMemo(() => users.filter((person) =>
    `${person.name} ${person.handle} ${person.profile?.bio ?? ''}`.toLowerCase().includes(term.trim().toLowerCase()),
  ), [users, term])

  const toggleFollow = async (person: DirectoryUser) => {
    if (busyId) return
    setBusyId(person.id)
    setError('')
    try {
      const following = person.relationship?.isFollowing ?? false
      const result = await apiRequest<{ following: boolean; followerCount: number }>(`/api/users/${encodeURIComponent(person.id)}/follow`, {
        method: following ? 'DELETE' : 'POST',
      })
      setUsers((current) => {
        return current.map((entry) => entry.id === person.id
          ? { ...entry, followerCount: result.followerCount, relationship: { ...entry.relationship, isFollowing: result.following, blockedByMe: false, blockedMe: false } }
          : entry)
      })
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update this connection.')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div>
        <p className="text-xs uppercase text-indigo-600">Discover</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900">Find people</h2>
      </div>

      <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
        <Search className="h-4 w-4" aria-hidden="true" />
        <input aria-label="Search users" placeholder="Search by name, username, or bio" value={term} onChange={(event) => setTerm(event.target.value)} className="min-w-0 flex-1 bg-transparent text-slate-800 placeholder:text-slate-400 focus:outline-none" />
      </label>

      {error ? <p role="alert" className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600">{error}</p> : null}
      {loading ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500">Loading people…</p> : null}
      {!loading && !error && filteredUsers.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No users match this search.</p> : null}

      <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
        {filteredUsers.map((person) => {
          const relationship = person.relationship
          const blocked = relationship?.blockedByMe || relationship?.blockedMe
          const following = relationship?.isFollowing ?? false
          return (
            <li key={person.id} className="flex flex-wrap items-center gap-3 p-4">
              <Link to={`/profile/${encodeURIComponent(person.id)}`} className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar src={person.avatar} alt={person.name} size="md" />
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-slate-900">{person.name}</span>
                  <span className="block truncate text-xs text-slate-500">@{person.handle} · {person.followerCount} followers</span>
                  {person.profile?.bio ? <span className="mt-1 block truncate text-sm text-slate-600">{person.profile.bio}</span> : null}
                </span>
              </Link>
              <Button
                variant={following ? 'secondary' : 'primary'}
                size="sm"
                disabled={Boolean(blocked) || busyId === person.id}
                onClick={() => void toggleFollow(person)}
                icon={following ? <UserRoundCheck className="h-4 w-4" aria-hidden="true" /> : <UserRoundPlus className="h-4 w-4" aria-hidden="true" />}
              >
                {blocked ? 'Blocked' : busyId === person.id ? 'Updating…' : following ? 'Following' : 'Follow'}
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}