import { Eye, EyeOff, ShieldCheck, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { ApiError } from '../lib/api'
import { useAuth } from '../context/AuthContext'

export type AuthMode = 'login' | 'register'

type AuthPageProps = {
  mode: AuthMode
}

export function AuthPage({ mode }: AuthPageProps) {
  const navigate = useNavigate()
  const { login, register, isLoading: authLoading, authError } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    username: '',
    phone: '',
    email: '',
    password: '',
    confirmPassword: '',
    communityRulesAccepted: false,
  })
  const [formError, setFormError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const isRegister = mode === 'register'

  const handleChange = (field: keyof typeof formData, value: string | boolean) => {
    setFormData((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: '' }))
    setFormError('')
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError('')
    setFieldErrors({})

    const nextFieldErrors: Record<string, string> = {}
    const name = formData.name.trim()
    const username = formData.username.trim()
    const email = formData.email.trim()
    const phone = formData.phone.trim()
    const password = formData.password
    const hasAccountIdentifier = Boolean(username || email || phone)

    if (isRegister && name.length < 2) nextFieldErrors.name = 'Please enter your name.'
    if (isRegister && username && !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      nextFieldErrors.username = 'Use 3-30 letters, numbers, or underscores.'
    }
    if (isRegister && !hasAccountIdentifier) {
      nextFieldErrors.username = 'Choose a username, email address, or phone number for your account.'
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nextFieldErrors.email = 'Please enter a valid email address.'
    }
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone.replace(/[\s()-]/g, ''))) {
      nextFieldErrors.phone = 'Enter a phone number with its international country code, such as +234...'
    }
    if (password.length < 8) nextFieldErrors.password = 'Password must be at least 8 characters.'
    if (isRegister && formData.confirmPassword !== password) {
      nextFieldErrors.confirmPassword = 'Passwords do not match.'
    }
    if (isRegister && !formData.communityRulesAccepted) {
      nextFieldErrors.communityRulesAccepted = 'You must accept the NOVAKOKO Community & Safety Rules.'
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors)
      return
    }

    setIsSubmitting(true)
    try {
      if (isRegister) {
        await register({
          name,
          username: username || undefined,
          phone: phone || undefined,
          email: email || undefined,
          password,
          communityRulesAccepted: formData.communityRulesAccepted,
        })
      } else {
        await login(formData.username.trim(), password)
      }
      navigate('/', { replace: true })
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message)
      } else if (error instanceof Error) {
        setFormError(error.message)
      } else {
        setFormError('We could not complete your request. Please try again.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  const inputClassName = 'mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-800 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100'

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-violet-50 to-cyan-50 p-4">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-2xl lg:grid-cols-[1.1fr_0.9fr]">
        <div className="hidden bg-gradient-to-br from-violet-600 via-indigo-600 to-cyan-500 p-8 text-white lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 text-xl font-black shadow-lg shadow-violet-500/20">
                N
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.32em] text-violet-100">NOVAKOKO</p>
                <p className="text-sm text-violet-100">Safe social connection</p>
              </div>
            </div>

            <div className="mt-12 max-w-md">
              <p className="text-xs uppercase tracking-[0.28em] text-violet-100">Family-first network</p>
              <h1 className="mt-4 text-4xl font-semibold leading-tight">A calmer, more meaningful place to connect.</h1>
            </div>
          </div>

          <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-emerald-300" aria-hidden="true" />
              <p className="font-semibold">Safety-first moderation</p>
            </div>
            <p className="mt-3 text-sm leading-6 text-violet-100">
              NOVAKOKO is a family-friendly platform with tools to help keep every space respectful, secure, and welcoming.
            </p>
          </div>
        </div>

        <div className="p-6 sm:p-8">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-violet-600">{isRegister ? 'Create account' : 'Welcome back'}</p>
              <h2 className="mt-2 text-3xl font-semibold text-slate-900">{isRegister ? 'Join NOVAKOKO' : 'Log in to NOVAKOKO'}</h2>
            </div>
            <Sparkles className="h-5 w-5 text-violet-600" aria-hidden="true" />
          </div>

          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            {isRegister ? (
              <>
                <label className="block text-sm font-medium text-slate-700">
                  Full name
                  <input autoComplete="name" value={formData.name} onChange={(event) => handleChange('name', event.target.value)} className={inputClassName} aria-invalid={Boolean(fieldErrors.name)} />
                  {fieldErrors.name ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.name}</span> : null}
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  Username
                  <input autoComplete="username" minLength={3} maxLength={30} value={formData.username} onChange={(event) => handleChange('username', event.target.value)} className={inputClassName} aria-invalid={Boolean(fieldErrors.username)} />
                  {fieldErrors.username ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.username}</span> : null}
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  Phone number <span className="font-normal text-slate-500">(optional, include country code)</span>
                  <input type="tel" autoComplete="tel" placeholder="+234..." value={formData.phone} onChange={(event) => handleChange('phone', event.target.value)} className={inputClassName} aria-invalid={Boolean(fieldErrors.phone)} />
                  {fieldErrors.phone ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.phone}</span> : null}
                </label>
                <label className="block text-sm font-medium text-slate-700">
                  Email <span className="font-normal text-slate-500">(optional)</span>
                  <input type="email" autoComplete="email" placeholder="name@example.com" value={formData.email} onChange={(event) => handleChange('email', event.target.value)} className={inputClassName} aria-invalid={Boolean(fieldErrors.email)} />
                  {fieldErrors.email ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.email}</span> : null}
                </label>
              </>
            ) : (
              <label className="block text-sm font-medium text-slate-700">
                Username, phone, or email
                <input autoComplete="username" value={formData.username} onChange={(event) => handleChange('username', event.target.value)} className={inputClassName} />
              </label>
            )}

            <label className="block text-sm font-medium text-slate-700">
              Password
              <div className="relative mt-1.5">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  value={formData.password}
                  onChange={(event) => handleChange('password', event.target.value)}
                  className={`${inputClassName} mt-0 pr-11`}
                  aria-invalid={Boolean(fieldErrors.password)}
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute inset-y-0 right-3 flex items-center text-slate-500 transition hover:text-slate-700"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              {fieldErrors.password ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.password}</span> : null}
            </label>

            {isRegister ? (
              <>
                <label className="block text-sm font-medium text-slate-700">
                  Confirm password
                  <input type="password" autoComplete="new-password" value={formData.confirmPassword} onChange={(event) => handleChange('confirmPassword', event.target.value)} className={inputClassName} aria-invalid={Boolean(fieldErrors.confirmPassword)} />
                  {fieldErrors.confirmPassword ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.confirmPassword}</span> : null}
                </label>

                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-semibold">NOVAKOKO Community &amp; Safety Rules</p>
                  <p className="mt-2 leading-6 text-amber-800">
                    NOVAKOKO is a family-friendly platform. Explicit sexual content, exploitation, harassment, and abusive behavior are not allowed.
                  </p>
                  <label className="mt-3 flex items-start gap-3 text-sm text-amber-900">
                    <input
                      type="checkbox"
                      checked={formData.communityRulesAccepted}
                      onChange={(event) => handleChange('communityRulesAccepted', event.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-amber-300 text-violet-600 focus:ring-violet-500"
                      aria-invalid={Boolean(fieldErrors.communityRulesAccepted)}
                    />
                    <span>I understand and agree to follow NOVAKOKO Community &amp; Safety Rules.</span>
                  </label>
                  {fieldErrors.communityRulesAccepted ? <span className="mt-1 block text-xs text-rose-700">{fieldErrors.communityRulesAccepted}</span> : null}
                </div>
              </>
            ) : null}

            {formError ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
                {formError}
              </div>
            ) : authError ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
                {authError}
              </div>
            ) : null}

            <Button type="submit" variant="primary" size="lg" className="mt-2 w-full" disabled={isSubmitting || authLoading}>
              {isSubmitting ? 'Please wait...' : isRegister ? 'Create account' : 'Log in'}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-slate-500">
            {isRegister ? 'Already have an account?' : 'Need an account?'}{' '}
            <Link to={isRegister ? '/login' : '/register'} className="font-semibold text-violet-700 hover:text-violet-800">
              {isRegister ? 'Log in' : 'Register'}
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
