import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Image, ShieldAlert, Video, X } from 'lucide-react'
import { apiRequest, uploadMedia, uploadVideo } from '../lib/api'
import { postMediaFileType, validatePostMediaFile } from '../lib/postMedia'
import { Button } from './ui/Button'

type PostComposerProps = {
  onClose: () => void
  onPublished: () => void
  inline?: boolean
}

type Visibility = 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE'

export function PostComposer({ onClose, onPublished, inline = false }: PostComposerProps) {
  const [content, setContent] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [uploadedMedia, setUploadedMedia] = useState<{ file: File; url: string } | null>(null)
  const [visibility, setVisibility] = useState<Visibility>('PUBLIC')
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const previewUrlRef = useRef('')
  const selectedMedia = mediaFile ? postMediaFileType(mediaFile) : null

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  const setMediaPreview = (file?: File) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = file ? URL.createObjectURL(file) : ''
    setPreviewUrl(previewUrlRef.current)
  }

  const chooseMedia = (file?: File) => {
    setError('')
    setUploadProgress(null)
    setUploadedMedia(null)
    if (!file) {
      setMediaFile(null)
      setMediaPreview()
      return
    }
    setMediaUrl('')
    const validationError = validatePostMediaFile(file)
    if (validationError) {
      setMediaFile(null)
      setMediaPreview()
      setError(validationError)
      return
    }
    const mediaType = postMediaFileType(file)
    if (!mediaType) {
      setMediaFile(null)
      setMediaPreview()
      setError('Choose a supported image or video file.')
      return
    }
    const normalizedFile = file.type === mediaType.type ? file : new File([file], file.name, { type: mediaType.type })
    setMediaFile(normalizedFile)
    setMediaPreview(normalizedFile)
  }

  const publishPost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    if (!content.trim()) {
      setError('Add some text before publishing your post.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      let publishedMediaUrl = mediaUrl.trim()
      if (mediaFile) {
        const previouslyUploadedUrl = uploadedMedia?.file === mediaFile ? uploadedMedia.url : ''
        if (previouslyUploadedUrl) {
          publishedMediaUrl = previouslyUploadedUrl
        } else {
          setUploadProgress(0)
          const upload = selectedMedia?.kind === 'video' ? uploadVideo : uploadMedia
          const uploaded = await upload(mediaFile, setUploadProgress)
          publishedMediaUrl = uploaded.mediaUrl
          setUploadedMedia({ file: mediaFile, url: uploaded.mediaUrl })
        }
      }
      await apiRequest('/api/posts', {
        method: 'POST',
        body: JSON.stringify({
          content: content.trim(),
          ...(publishedMediaUrl ? { imageUrl: publishedMediaUrl } : {}),
          visibility,
        }),
      })
      onPublished()
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Unable to publish this post.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={inline ? 'mt-3' : 'fixed inset-0 z-50 flex items-end justify-center bg-slate-950/55 p-0 sm:items-center sm:p-4'} {...(inline ? {} : { role: 'dialog', 'aria-modal': true })} aria-labelledby="post-composer-title">
      <form onSubmit={(event) => void publishPost(event)} className={inline ? 'w-full rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6' : 'max-h-[95dvh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white p-4 shadow-2xl sm:rounded-3xl sm:p-6'}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-indigo-600">Create</p>
            <h2 id="post-composer-title" className="mt-1 text-xl font-semibold text-slate-900">Share a post</h2>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="Close post composer" className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <textarea
          aria-label="Post content"
          placeholder="What's on your mind?"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          maxLength={2500}
          required
          className="mt-5 min-h-36 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
        />

        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600">
            <Image className="h-4 w-4 shrink-0" aria-hidden="true" />
            <input
              type="url"
              aria-label="Image URL"
              value={mediaUrl}
              onChange={(event) => { setMediaUrl(event.target.value); setMediaFile(null); setUploadedMedia(null); setUploadProgress(null); setMediaPreview() }}
              placeholder="Optional HTTPS image URL"
              disabled={Boolean(mediaFile)}
              className="min-w-0 flex-1 bg-transparent outline-none disabled:opacity-50"
            />
          </label>
          <label className="cursor-pointer rounded-xl bg-indigo-50 px-4 py-2 text-center text-sm font-semibold text-indigo-700 hover:bg-indigo-100">
            Add photo or video
            <input
              type="file"
              aria-label="Upload post image or video"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/ogg,.jpg,.jpeg,.png,.webp,.mp4,.webm,.ogg"
              onChange={(event) => { chooseMedia(event.target.files?.[0]); event.currentTarget.value = '' }}
              className="sr-only"
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-500">Images up to 10 MB · Videos up to 100 MB</p>

        {mediaFile && selectedMedia ? (
          <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
            {selectedMedia.kind === 'video'
              ? <video src={previewUrl} controls playsInline className="max-h-72 w-full object-contain" />
              : <img src={previewUrl} alt="Selected post preview" className="max-h-72 w-full object-contain" />}
            <div className="flex items-center justify-between gap-3 bg-white px-3 py-2 text-xs text-slate-600">
              <span className="min-w-0 truncate">{mediaFile.name} · {(mediaFile.size / 1024 / 1024).toFixed(1)} MB</span>
              <button type="button" onClick={() => chooseMedia()} className="shrink-0 font-semibold text-rose-700">Remove</button>
            </div>
          </div>
        ) : mediaUrl ? <div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600"><Video className="h-4 w-4" aria-hidden="true" /><span className="min-w-0 truncate">{mediaUrl}</span></div> : null}

        {uploadProgress !== null ? <div className="mt-3" aria-live="polite">
          <div className="mb-1 flex justify-between text-xs text-slate-600"><span>Uploading {mediaFile?.name}</span><span>{uploadProgress}%</span></div>
          <progress aria-label="Upload progress" max={100} value={uploadProgress} className="h-2 w-full accent-indigo-600" />
        </div> : null}

        <label className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600">
          <span>Who can see this post?</span>
          <select aria-label="Post privacy" value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800">
            <option value="PUBLIC">Everyone</option>
            <option value="FOLLOWERS">Followers</option>
            <option value="PRIVATE">Only me</option>
          </select>
        </label>

        <div className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>Posts are checked under NOVAKOKO community safety rules before publication.</p>
        </div>
        {error ? <p className="mt-3 text-sm text-rose-700" role="alert">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={submitting || !content.trim()}>
            {submitting ? uploadProgress !== null ? 'Uploading and publishing…' : 'Publishing…' : 'Publish post'}
          </Button>
        </div>
      </form>
    </div>
  )
}
