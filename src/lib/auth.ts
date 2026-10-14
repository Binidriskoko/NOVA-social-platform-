import { apiRequest, ApiError } from './api'
import { clearStoredAccessToken, storeAccessToken } from './session'

export type AuthUser = {
  id: string
  email: string | null
  phoneE164?: string | null
  username?: string | null
  name: string
  role?: string
  status?: string
  createdAt?: string
  updatedAt?: string
}

export type AuthResponse = {
  user: AuthUser
  token: string
  message?: string
}

export type RegisterInput = {
  name: string
  username?: string
  phone?: string
  email?: string
  password: string
  communityRulesAccepted: boolean
}

export type LoginInput = {
  identifier: string
  password: string
}

export async function registerUser(input: RegisterInput) {
  const response = await apiRequest<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  storeAccessToken(response.token)
  return response
}

export async function loginUser(input: LoginInput) {
  const response = await apiRequest<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  storeAccessToken(response.token)
  return response
}

export async function logoutUser() {
  const response = await apiRequest<{ message: string }>('/api/auth/logout', {
    method: 'POST',
  })
  clearStoredAccessToken()
  return response
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const response = await apiRequest<{ user: AuthUser }>('/api/auth/me')
    return response.user ?? null
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clearStoredAccessToken()
      return null
    }

    throw error
  }
}
