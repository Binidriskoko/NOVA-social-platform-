export const POST_MEDIA_MAX_BYTES = 10 * 1024 * 1024

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
  if (file.size > POST_MEDIA_MAX_BYTES) return 'Images and videos must be 10 MB or smaller.'
  if (!postMediaFileType(file)) return 'Choose a JPEG, PNG, or WebP image, or an MP4, WebM, or Ogg video.'
  return ''
}

export function isVideoPostMediaUrl(url: string) {
  const path = url.split(/[?#]/, 1)[0].toLowerCase()
  return /\.(?:mp4|webm|ogg)$/.test(path)
}
