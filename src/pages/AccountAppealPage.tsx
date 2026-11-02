import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { apiRequest } from '../lib/api'
import { useAuth } from '../context/AuthContext'

type AccountAppeal = {
  id: string
  originalAction: string
  reason: string
  status: 'OPEN' | 'APPROVED' | 'REJECTED'
  reviewerNote: string | null
  createdAt: string
  reviewedAt: string | null
}

export function AccountAppealPage() {
  const { refreshCurrentUser, logout } = useAuth()
  const navigate = useNavigate()
  const [appeals, setAppeals] = useState<AccountAppeal[]>([])
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [persistence, setPersistence] = useState<'database' | 'in-memory' | null>(null)

  useEffect(() => {
    let active = true
    apiRequest<{ appeals: AccountAppeal[]; persistence: 'database' | 'in-memory' }>('/api/auth/appeals/me')
      .then(({ appeals: currentAppeals, persistence: currentPersistence }) => {
        if (active) {
          setAppeals(currentAppeals)
          setPersistence(currentPersistence)
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Appeal history could not be loaded.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const submitAppeal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { appeal, persistence: currentPersistence } = await apiRequest<{ appeal: AccountAppeal; persistence: 'database' | 'in-memory' }>('/api/auth/appeals', {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
      setAppeals((current) => [appeal, ...current])
      setPersistence(currentPersistence)
      setReason('')
      setNotice(currentPersistence === 'in-memory'
        ? 'Your appeal was submitted for review, but this development copy is stored only in memory and will not survive a server restart.'
        : 'Your appeal was submitted for review.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your appeal could not be submitted.')
    } finally {
      setBusy(false)
    }
  }

  const checkAccountStatus = async () => {
    setBusy(true)
    setError('')
    try {
      const user = await refreshCurrentUser()
      if (user?.status === 'ACTIVE') navigate('/', { replace: true })
      else setNotice('Your account is still restricted. Please wait for an appeal decision.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Account status could not be checked.')
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = async () => {
    setBusy(true)
    setError('')
    try {
      await logout()
      navigate('/login', { replace: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Log out could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  const openAppeal = appeals.some((appeal) => appeal.status === 'OPEN')

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <section className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-700">Account review</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Your account is restricted</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          You can submit an appeal for administrator review. Access remains restricted unless an administrator approves the appeal.
        </p>

        {error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}
        {notice ? <p role="status" className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p> : null}
        {persistence === 'in-memory' ? <p role="status" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Appeal history is using temporary in-memory storage. Configure PostgreSQL for durable storage; current fallback data may be lost when the server restarts.</p> : null}

        {loading ? <p className="mt-6 text-sm text-slate-500" role="status">Loading appeal history…</p> : (
          <>
            {openAppeal ? (
              <p className="mt-6 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Your appeal is awaiting review.</p>
            ) : (
              <form className="mt-6 space-y-3" onSubmit={(event) => void submitAppeal(event)}>
                <label htmlFor="appeal-reason" className="block text-sm font-medium text-slate-700">Explain why you are appealing (20–2000 characters)</label>
                <textarea
                  id="appeal-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  minLength={20}
                  maxLength={2000}
                  required
                  rows={5}
                  className="w-full rounded-2xl border border-slate-300 p-3 text-sm text-slate-900 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-100"
                />
                <Button type="submit" disabled={busy || reason.trim().length < 20}>Submit appeal</Button>
              </form>
            )}

            {appeals.length > 0 ? (
              <section className="mt-7 space-y-3" aria-labelledby="appeal-history-heading">
                <h2 id="appeal-history-heading" className="text-sm font-semibold text-slate-900">Appeal history</h2>
                {appeals.map((appeal) => (
                  <article key={appeal.id} className="rounded-2xl border border-slate-200 p-4">
                    <p className="text-sm font-semibold text-slate-800">{appeal.status}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{appeal.reason}</p>
                    {appeal.reviewerNote ? <p className="mt-2 text-sm text-slate-500">Review note: {appeal.reviewerNote}</p> : null}
                  </article>
                ))}
              </section>
            ) : null}
          </>
        )}

        <div className="mt-7 flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void checkAccountStatus()} disabled={busy}>Check account status</Button>
          <Button variant="ghost" onClick={() => void handleLogout()} disabled={busy}>Log out</Button>
        </div>
      </section>
    </main>
  )
}
