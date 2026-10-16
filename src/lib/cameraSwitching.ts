export type CameraDevice = Pick<MediaDeviceInfo, 'deviceId' | 'label'>

const userFacing = /\b(front|user|facetime)\b/i
const environmentFacing = /\b(back|rear|environment|world)\b/i

export function chooseNextCamera(
  devices: CameraDevice[],
  currentDeviceId: string | undefined,
  currentFacingMode?: string,
) {
  if (devices.length < 2) return null
  const currentIndex = Math.max(0, devices.findIndex((device) => device.deviceId === currentDeviceId))
  const current = devices[currentIndex]
  const currentLooksUserFacing = currentFacingMode === 'user' || userFacing.test(current.label)
  const currentLooksEnvironmentFacing = currentFacingMode === 'environment' || environmentFacing.test(current.label)
  const preferredPattern = currentLooksUserFacing ? environmentFacing : currentLooksEnvironmentFacing ? userFacing : null
  const preferred = preferredPattern && devices.find((device, index) => index !== currentIndex && preferredPattern.test(device.label))
  return preferred ?? devices[(currentIndex + 1) % devices.length]
}

export async function switchToNextCamera(
  devices: CameraDevice[],
  currentDeviceId: string | undefined,
  currentFacingMode: string | undefined,
  switchDevice: (deviceId: string) => Promise<boolean>,
) {
  const nextCamera = chooseNextCamera(devices, currentDeviceId, currentFacingMode)
  if (!nextCamera) throw new Error('No alternate camera is available on this device.')
  if (!nextCamera.deviceId) throw new Error('The alternate camera is unavailable. Check your camera permissions and try again.')
  const switched = await switchDevice(nextCamera.deviceId)
  if (!switched) throw new Error('Your device could not switch to the selected camera.')
  return nextCamera
}

export function cameraSwitchErrorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') return 'Camera permission was denied. Allow camera access and try again.'
    if (error.name === 'NotFoundError') return 'No alternate camera is available on this device.'
    if (error.name === 'NotReadableError') return 'The camera is unavailable or already in use by another app.'
    if (error.name === 'OverconstrainedError') return 'The selected camera is not available on this device.'
    return error.message || 'Unable to switch cameras.'
  }
  return 'Unable to switch cameras.'
}
