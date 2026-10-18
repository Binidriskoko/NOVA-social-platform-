import { useEffect, useState } from 'react'
import { apiRequest } from '../lib/api'
import { Button } from '../components/ui/Button'

type Campaign = {
  id: string
  name: string
  placement: { key: string } | string
  status: string
  totalBudgetCents: number
  spendCents: number
  startsAt: string
  endsAt: string
}

const initialStart = () => {
  const date = new Date(Date.now() + 60_000)
  date.setSeconds(0, 0)
  return date.toISOString().slice(0, 16)
}

const initialEnd = () => {
  const date = new Date(Date.now() + 86_400_000)
  date.setSeconds(0, 0)
  return date.toISOString().slice(0, 16)
}

export function AdCampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [name, setName] = useState('')
  const [placement, setPlacement] = useState<'feed' | 'content'>('feed')
  const [creativeUrl, setCreativeUrl] = useState('')
  const [destinationUrl, setDestinationUrl] = useState('')
  const [startsAt, setStartsAt] = useState(initialStart)
  const [endsAt, setEndsAt] = useState(initialEnd)
  const [totalBudget, setTotalBudget] = useState('')
  const [dailyBudget, setDailyBudget] = useState('')
  const [impressionCost, setImpressionCost] = useState('0')
  const [clickCost, setClickCost] = useState('0')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadCampaigns = async () => {
    setError('')
    try {
      const response = await apiRequest<{ campaigns: Campaign[] }>('/api/ads/campaigns/me')
      setCampaigns(response.campaigns)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load campaigns.')
    } finally { setLoading(false) }
  }

  useEffect(() => { void loadCampaigns() }, [])

  const createCampaign = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const totalBudgetCents = Math.round(Number(totalBudget) * 100)
    const dailyBudgetCents = Math.round(Number(dailyBudget) * 100)
    if (!Number.isSafeInteger(totalBudgetCents) || !Number.isSafeInteger(dailyBudgetCents)) {
      setError('Enter valid campaign budgets.')
      return
    }
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await apiRequest<{ campaign: Campaign }>('/api/ads/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name, placement, creativeUrl, destinationUrl,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          totalBudgetCents,
          dailyBudgetCents,
          costPerImpressionCents: Number(impressionCost),
          costPerClickCents: Number(clickCost),
        }),
      })
      setCampaigns((current) => [response.campaign, ...current])
      await apiRequest(`/api/ads/campaigns/${encodeURIComponent(response.campaign.id)}/submit`, { method: 'POST' })
      setNotice('Campaign submitted for administrator review. Spending is tracked internally; no payment provider is configured.')
      await loadCampaigns()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create or submit campaign.')
    } finally { setBusy(false) }
  }

  const submit = async (campaignId: string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      await apiRequest(`/api/ads/campaigns/${encodeURIComponent(campaignId)}/submit`, { method: 'POST' })
      setNotice('Campaign submitted for review.')
      await loadCampaigns()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to submit campaign.')
    } finally { setBusy(false) }
  }

  return <div className="space-y-5 p-4 pb-24 sm:p-6">
    <header className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-semibold uppercase tracking-widest text-violet-600">NOVAKOKO Ads</p>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900">Campaigns</h1>
      <p className="mt-1 text-sm text-slate-600">Create a campaign for a public placement and submit it for administrator review.</p>
    </header>
    {error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}
    {notice ? <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</p> : null}
    <form onSubmit={(event) => void createCampaign(event)} className="grid gap-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:grid-cols-2">
      <label className="text-sm font-medium">Campaign name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm font-medium">Public placement<select value={placement} onChange={(event) => setPlacement(event.target.value as 'feed' | 'content')} className="mt-1 w-full rounded-xl border p-2"><option value="feed">Feed</option><option value="content">Public content</option></select></label>
      <label className="text-sm font-medium sm:col-span-2">Creative image URL<input required type="url" value={creativeUrl} onChange={(event) => setCreativeUrl(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm font-medium sm:col-span-2">Destination URL<input required type="url" value={destinationUrl} onChange={(event) => setDestinationUrl(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm font-medium">Starts<input required type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm font-medium">Ends<input required type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm font-medium">Total budget (USD)<input required type="number" min="0.01" step="0.01" value={totalBudget} onChange={(event) => setTotalBudget(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm font-medium">Daily cap (USD)<input required type="number" min="0.01" step="0.01" value={dailyBudget} onChange={(event) => setDailyBudget(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm font-medium">Cost per impression (cents)<input required type="number" min="0" value={impressionCost} onChange={(event) => setImpressionCost(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm font-medium">Cost per click (cents)<input required type="number" min="0" value={clickCost} onChange={(event) => setClickCost(event.target.value)} className="mt-1 w-full rounded-xl border p-2" /></label>
      <p className="text-xs text-slate-500 sm:col-span-2">Impressions are recorded when an opted-in user is served an ad; clicks require that impression. Private messages, groups and calls are excluded. This is not an external ad provider or payment integration.</p>
      <div className="sm:col-span-2"><Button type="submit" disabled={busy}>Create and submit campaign</Button></div>
    </form>
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="text-lg font-semibold">Your campaigns</h2>
      {loading ? <p className="mt-3 text-sm text-slate-500">Loading…</p> : campaigns.length ? <div className="mt-3 space-y-3">{campaigns.map((campaign) => <article key={campaign.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-3">
        <div><h3 className="font-medium text-slate-900">{campaign.name}</h3><p className="text-xs text-slate-500">{typeof campaign.placement === 'string' ? campaign.placement : campaign.placement.key} · {campaign.status} · {new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(campaign.spendCents / 100)} / {new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(campaign.totalBudgetCents / 100)}</p></div>
        {['DRAFT', 'REJECTED'].includes(campaign.status) ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void submit(campaign.id)}>Submit for review</Button> : null}
      </article>)}</div> : <p className="mt-3 text-sm text-slate-500">No campaigns created yet.</p>}
    </section>
  </div>
}
