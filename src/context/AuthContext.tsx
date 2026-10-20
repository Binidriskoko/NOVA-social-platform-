import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { getCurrentUser, loginUser, logoutUser, registerUser, type AuthUser, type RegisterInput } from '../lib/auth'
import { authSessionReducer, initialAuthSessionState } from '../lib/authSession'

type AuthContextValue = {
  user: AuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  authError: string | null
  login: (identifier: string, password: string) => Promise<AuthUser>
  register: (input: RegisterInput) => Promise<AuthUser>
  logout: () => Promise<void>
  refreshCurrentUser: () => Promise<AuthUser | null>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [{ user, isLoading, authError }, dispatch] = useReducer(authSessionReducer, initialAuthSessionState)

  const refreshCurrentUser = useCallback(async () => {
    dispatch({ type: 'verification-started' })

    try {
      const nextUser = await getCurrentUser()
      dispatch({ type: 'verification-succeeded', user: nextUser })
      return nextUser
    } catch (error) {
      dispatch({
        type: 'verification-failed',
        message: error instanceof Error ? error.message : 'Unable to verify your session.',
      })
      throw error
    }
  }, [])

  useEffect(() => {
    void refreshCurrentUser().catch(() => undefined)
  }, [refreshCurrentUser])

  const login = useCallback(async (identifier: string, password: string) => {
    dispatch({ type: 'clear-error' })
    const response = await loginUser({ identifier, password })
    dispatch({ type: 'authenticated', user: response.user })
    return response.user
  }, [])

  const register = useCallback(async (input: RegisterInput) => {
    dispatch({ type: 'clear-error' })
    const response = await registerUser(input)
    dispatch({ type: 'authenticated', user: response.user })
    return response.user
  }, [])

  const logout = useCallback(async () => {
    await logoutUser()
    dispatch({ type: 'logged-out' })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: Boolean(user),
      authError,
      login,
      register,
      logout,
      refreshCurrentUser,
    }),
    [user, isLoading, authError, login, register, logout, refreshCurrentUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }

  return context
}
