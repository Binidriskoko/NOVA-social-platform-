export const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const POST_VIDEO_MAX_BYTES = 100 * 1024 * 1024
export const POST_MEDIA_MAX_BYTES = POST_VIDEO_MAX_BYTES

const supportedPostMedia = {
  jpg: { type: 'image/jpeg', kind: 'image' },
  jpeg: { type: 'image/jpeg', kind: 'image' },
  png: { type: 'image/png', kind: 'image' },
  webp: { type: 'image/webp', kind: 'image' },
  mp4: { type: 'video/mp4', kind: 'video' },
  webm: { type: 'video/webm', kind: 'video' },
  ogg: { type: 'video/ogg', kind: 'video' },
} as const

export type PostMediaKind = 'image' | 'video'

export function postMediaFileType(file: File) {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
  const supported = supportedPostMedia[extension as keyof typeof supportedPostMedia]
  if (!supported) return null
  const actualType = file.type.split(';')[0].trim().toLowerCase()
  if (actualType && actualType !== supported.type) return null
  return { ...supported, type: supported.type }
}

export function validatePostMediaFile(file: File) {
  const mediaType = postMediaFileType(file)
  if (!mediaType) return 'Choose a JPEG, PNG, or WebP image, or an MP4, WebM, or Ogg video.'
  if (file.size > (mediaType.kind === 'video' ? POST_VIDEO_MAX_BYTES : POST_IMAGE_MAX_BYTES)) {
    return mediaType.kind === 'video' ? 'Videos must be 100 MB or smaller.' : 'Images must be 10 MB or smaller.'
  }
  return ''
}

export function isVideoPostMediaUrl(url: string) {
  const path = url.split(/[?#]/, 1)[0].toLowerCase()
  return /\.(?:mp4|webm|ogg)$/.test(path)
}
