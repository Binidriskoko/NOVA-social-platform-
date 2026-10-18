import { useEffect, useState } from 'react'
import { apiRequest } from '../lib/api'
import { Button } from '../components/ui/Button'

type CreatorApplication = { id: string; status: string; reviewNote: string | null; createdAt: string }
type LedgerEntry = { id: string; type: string; amountCents: number; currency: string; createdAt: string; description?: string | null }
type Payout = { id: string; amountCents: number; currency: string; status: string; requestedAt: string; providerReference?: string | null }
type MonetizationDashboard = {
  settings: { minimumPayoutCents: number }
  eligible: boolean
  approved: boolean
  active: boolean
  metrics: { followers: number; qualifiedViews: number | null; watchTimeSeconds: number | null; publicPosts: number; engagements: number; engagementRate: number; accountAgeDays: number }
  requirements: Array<{ key: string; label: string; required: number | boolean; actual?: number | null; met: boolean; available?: boolean }>
  applications: CreatorApplication[]
  earnings: { entries: LedgerEntry[]; estimatedBalanceCents: number; paidCents: number; pendingPayoutCents: number; payouts: Payout[] }
}

function money(amountCents: number, currency = 'USD') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amountCents / 100)
}

export function CreatorMonetizationPage() {
  const [dashboard, setDashboard] = useState<MonetizationDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reason, setReason] = useState('')
  const [payoutAmount, setPayoutAmount] = useState('')

  const loadDashboard = async () => {
    setError('')
    try {
      const response = await apiRequest<MonetizationDashboard>('/api/creators/me/monetization')
      setDashboard(response)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Ba a iya loda bayanan monetization ba.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadDashboard() }, [])

  const apply = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      await apiRequest('/api/creators/me/monetization/applications', { method: 'POST', body: JSON.stringify({ reason: reason.trim() || undefined }) })
      setReason('')
      setNotice('An aika da bukatar monetization don dubawa.')
      await loadDashboard()
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Ba a iya aika da bukatar ba.')
    } finally { setBusy(false) }
  }

  const requestPayout = async () => {
    const amountCents = Math.round(Number(payoutAmount) * 100)
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      setError('Shigar da adadi ingantacce na kudin da za a nema.')
      return
    }
    setBusy(true); setError(''); setNotice('')
    try {
      await apiRequest('/api/creators/me/payouts', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ amountCents }),
      })
      setPayoutAmount('')
      setNotice('An adana bukatar biyan kudi; ba a aika kudi ba tukuna.')
      await loadDashboard()
    } catch (payoutError) {
      setError(payoutError instanceof Error ? payoutError.message : 'Ba a iya neman biyan kudi ba.')
    } finally { setBusy(false) }
  }

  if (loading) return <div className="p-6 text-sm text-slate-600" role="status">Ana loda bayanan monetization…</div>
  if (!dashboard) return <section className="space-y-3 p-6"><h1 className="text-xl font-semibold">Monetization na creator</h1><p role="alert" className="text-sm text-rose-600">{error}</p><Button onClick={() => { setLoading(true); void loadDashboard() }}>Sake gwadawa</Button></section>

  const pendingApplication = dashboard.applications.some((application) => application.status === 'PENDING')
  const latestApplication = dashboard.applications[0]
  const currency = dashboard.earnings.entries[0]?.currency ?? dashboard.earnings.payouts[0]?.currency ?? 'USD'
  return <div className="space-y-5 p-4 pb-24 sm:p-6">
    <header className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-semibold uppercase tracking-widest text-violet-600">NOVAKOKO creators</p>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900">Monetization</h1>
      <p className="mt-1 text-sm text-slate-600">Duba cancanta, matsayin aikace-aikace, kudaden shiga da bukatun biyan kudi.</p>
    </header>
    {error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}
    {notice ? <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</p> : null}
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[
        ['Masu bi', dashboard.metrics.followers.toLocaleString()],
        ['Posts na jama’a', dashboard.metrics.publicPosts.toLocaleString()],
        ['Ayyukan hulda', dashboard.metrics.engagements.toLocaleString()],
        ['Shekarun asusu (kwanaki)', dashboard.metrics.accountAgeDays.toLocaleString()],
      ].map(([label, value]) => <div key={label} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p></div>)}
    </section>
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-lg font-semibold">Cancantar shiga</h2>
      <p className="mt-1 text-sm text-slate-500">Matsayin: {dashboard.active ? 'An kunna' : dashboard.approved ? 'An dakatar' : latestApplication?.status === 'PENDING' ? 'Ana dubawa' : latestApplication?.status === 'REJECTED' ? 'An ki amincewa' : 'Ba a nema ba'}</p>
      <ul className="mt-4 space-y-2">{dashboard.requirements.map((requirement) => <li key={requirement.key} className={`rounded-xl p-3 text-sm ${requirement.met ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}>
        <span className="font-medium">{requirement.met ? '✓ ' : '• '}{requirement.label}</span>
        {requirement.actual !== undefined ? <span className="ml-2 text-xs">({requirement.actual === null ? 'Ba a auna ba' : String(requirement.actual)})</span> : null}
      </li>)}</ul>
      {latestApplication?.reviewNote ? <p className="mt-3 text-sm text-slate-600">Bayanin mai dubawa: {latestApplication.reviewNote}</p> : null}
      {!dashboard.approved && !pendingApplication ? <div className="mt-4 space-y-3">
        <label className="block text-sm font-medium text-slate-700">Bayani game da bukatar (na zaɓi)<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} className="mt-1 w-full rounded-xl border border-slate-200 p-3" /></label>
        <Button onClick={() => void apply()} disabled={busy || !dashboard.eligible}>Nemi shiga monetization</Button>
        {!dashboard.eligible ? <p className="text-xs text-slate-500">Dole ne a cika duk bukatun da aka auna kafin nema.</p> : null}
      </div> : null}
    </section>
    <section className="grid gap-4 md:grid-cols-3">
      {[
        ['Ma’aunin da ake tsammani', dashboard.earnings.estimatedBalanceCents],
        ['Biyan da ke jiran dubawa', dashboard.earnings.pendingPayoutCents],
        ['An biya da gaske', dashboard.earnings.paidCents],
      ].map(([label, amount]) => <div key={String(label)} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-xl font-semibold text-slate-900">{money(Number(amount), currency)}</p></div>)}
    </section>
    {dashboard.active ? <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-lg font-semibold">Neman biyan kudi</h2>
      <p className="mt-1 text-sm text-slate-500">Ana bukatar mafi karanci {money(dashboard.settings.minimumPayoutCents, currency)}. Mai gudanarwa zai duba bukatar; ba a haɗa mai biyan kuɗi ba.</p>
      <div className="mt-3 flex flex-wrap gap-2"><label className="sr-only" htmlFor="payout-amount">Adadin USD</label><input id="payout-amount" type="number" min="0.01" step="0.01" value={payoutAmount} onChange={(event) => setPayoutAmount(event.target.value)} placeholder="Adadi a USD" className="min-w-48 rounded-xl border border-slate-200 p-2" /><Button onClick={() => void requestPayout()} disabled={busy}>Aika bukata</Button></div>
    </section> : null}
    <section className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><h2 className="text-lg font-semibold">Tarihin kudaden shiga</h2><div className="mt-3 space-y-2">{dashboard.earnings.entries.length ? dashboard.earnings.entries.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 text-sm"><span>{entry.description ?? entry.type}<small className="block text-xs text-slate-500">{new Date(entry.createdAt).toLocaleDateString()}</small></span><strong>{money(entry.amountCents, entry.currency)}</strong></div>) : <p className="text-sm text-slate-500">Babu bayanan kudaden shiga tukuna.</p>}</div></div>
      <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><h2 className="text-lg font-semibold">Tarihin payout</h2><div className="mt-3 space-y-2">{dashboard.earnings.payouts.length ? dashboard.earnings.payouts.map((payout) => <div key={payout.id} className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 text-sm"><span>{payout.status}<small className="block text-xs text-slate-500">{new Date(payout.requestedAt).toLocaleDateString()}</small></span><strong>{money(payout.amountCents, payout.currency)}</strong></div>) : <p className="text-sm text-slate-500">Babu bukatar payout tukuna.</p>}</div></div>
    </section>
  </div>
}
