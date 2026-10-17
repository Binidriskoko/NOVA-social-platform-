import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Camera, Check, UserRound } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { apiRequest, resolveMediaUrl, uploadMedia } from '../lib/api'

type PrivateProfile = { dateOfBirth: string; address: string; avatarUrl: string }

export function CompleteProfilePage() {
  const navigate = useNavigate()
  const [profile, setProfile] = useState<PrivateProfile>({ dateOfBirth: '', address: '', avatarUrl: '' })
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const previewRef = useRef('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const today = new Date().toISOString().slice(0, 10)

  useEffect(() => {
    let active = true
    apiRequest<PrivateProfile>('/api/users/me/private-profile')
      .then((data) => { if (active) setProfile(data) })
      .catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load profile details.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
  }, [])

  const chooseImage = (file?: File) => {
    setError('')
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP profile picture.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('Profile pictures must be 10 MB or smaller.')
      return
    }
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = URL.createObjectURL(file)
    setPreviewUrl(previewRef.current)
    setImageFile(file)
    setSaved(false)
  }

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSaved(false)
    if (!profile.dateOfBirth || !profile.address.trim()) {
      setError('Enter your date of birth and address, or choose “Do this later”.')
      return
    }
    if (profile.dateOfBirth > today) {
      setError('Date of birth cannot be in the future.')
      return
    }
    setSaving(true)
    try {
      let avatarUrl = profile.avatarUrl
      if (imageFile) {
        setUploadProgress(0)
        avatarUrl = (await uploadMedia(imageFile, setUploadProgress)).mediaUrl
      }
      if (imageFile) await apiRequest('/api/users/me/profile', { method: 'PUT', body: JSON.stringify({ avatarUrl }) })
      const updated = await apiRequest<Pick<PrivateProfile, 'dateOfBirth' | 'address'>>('/api/users/me/private-profile', {
        method: 'PUT',
        body: JSON.stringify({ dateOfBirth: profile.dateOfBirth, address: profile.address.trim() }),
      })
      setProfile((current) => ({ ...current, ...updated, avatarUrl }))
      setImageFile(null)
      setSaved(true)
      setUploadProgress(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save your profile details.')
    } finally {
      setSaving(false)
    }
  }

  return <main className="min-h-screen bg-[#f3f7f4] px-4 py-8 text-slate-900 sm:py-12">
    <div className="mx-auto max-w-xl">
      <Link to="/" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> NOVAKOKO</Link>
      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#087b43]">Stage 2</p>
        <h1 className="mt-2 text-2xl font-semibold">Complete Your Profile</h1>
        <p className="mt-2 text-sm text-slate-600">Your address and date of birth are private and are not shown on your public profile.</p>
        {loading ? <p className="mt-5 text-sm text-slate-500" role="status">Loading profile details…</p> : <form onSubmit={(event) => void saveProfile(event)} className="mt-6 space-y-5">
          <div className="flex items-center gap-4">
            <Avatar src={previewUrl || resolveMediaUrl(profile.avatarUrl)} alt="Profile picture preview" size="lg" />
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              <Camera className="h-4 w-4" aria-hidden="true" /> Choose profile picture
              <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Profile picture upload" className="sr-only" onChange={(event) => { chooseImage(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} />
            </label>
          </div>
          <label className="block text-sm font-medium text-slate-700">Date of birth
            <input type="date" max={today} value={profile.dateOfBirth} onChange={(event) => { setProfile((current) => ({ ...current, dateOfBirth: event.target.value })); setSaved(false) }} required className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2.5" />
          </label>
          <label className="block text-sm font-medium text-slate-700">Address
            <textarea value={profile.address} onChange={(event) => { setProfile((current) => ({ ...current, address: event.target.value })); setSaved(false) }} maxLength={300} rows={3} required className="mt-1.5 w-full resize-y rounded-lg border border-slate-200 px-3 py-2.5" />
          </label>
          {uploadProgress !== null ? <div aria-live="polite"><div className="mb-1 flex justify-between text-xs text-slate-600"><span>Uploading profile picture</span><span>{uploadProgress}%</span></div><progress aria-label="Profile picture upload progress" max={100} value={uploadProgress} className="h-2 w-full accent-[#078744]" /></div> : null}
          {error ? <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p> : null}
          {saved ? <p role="status" className="flex items-center gap-2 text-sm font-medium text-emerald-700"><Check className="h-4 w-4" aria-hidden="true" /> Profile details saved.</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <button type="button" onClick={() => navigate('/')} className="text-sm font-semibold text-slate-500 hover:text-slate-800">Do this later</button>
            <div className="flex items-center gap-2"><UserRound className="hidden h-4 w-4 text-slate-400 sm:block" aria-hidden="true" /><Button type="submit" variant="primary" disabled={saving}>{saving ? uploadProgress !== null ? 'Uploading…' : 'Saving…' : 'Save profile'}</Button>{saved ? <Button type="button" variant="secondary" onClick={() => navigate('/')}>Continue</Button> : null}</div>
          </div>
        </form>}
      </section>
    </div>
  </main>
}