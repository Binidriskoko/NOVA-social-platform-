const productionApiBaseUrl = 'https://nova-social-platform-api.onrender.com'

export function resolveApiBaseUrl(
  configuredApiBaseUrl: string | undefined,
  platform: string,
  isProduction: boolean,
) {
  const configured = configuredApiBaseUrl?.trim()
  const baseUrl = configured || (platform === 'android'
    ? productionApiBaseUrl
    : isProduction ? '' : productionApiBaseUrl)

  return baseUrl.replace(/\/$/, '')
}
