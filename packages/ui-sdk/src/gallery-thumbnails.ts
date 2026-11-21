import { useEffect, useRef, useState } from 'react'

type Thumbnail = { readonly status: 'loading' | 'error' } | { readonly status: 'ready'; readonly url: string }

async function downsize(image: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  try {
    const scale = Math.min(1, 128 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create a thumbnail canvas')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode the thumbnail')), 'image/webp', 0.85)
    })
  } finally {
    bitmap.close()
  }
}

/** Keep only small thumbnails for the current owner gallery page in memory. */
export function useGalleryThumbnails(
  items: readonly { readonly assetId: string }[],
  enabled: boolean,
  visible: boolean,
  fetchImage: (assetId: string, signal: AbortSignal) => Promise<Blob>,
): Readonly<Record<string, Thumbnail>> {
  const cache = useRef(new Map<string, Blob>())
  const [thumbnails, setThumbnails] = useState<Readonly<Record<string, Thumbnail>>>({})

  useEffect(() => {
    const images = cache.current
    const clear = () => images.clear()
    window.addEventListener('pagehide', clear)
    return () => { window.removeEventListener('pagehide', clear); clear() }
  }, [])

  useEffect(() => {
    const images = cache.current
    if (!enabled) images.clear()
    const ids = new Set(items.map(item => item.assetId))
    for (const id of images.keys()) {
      if (!ids.has(id)) images.delete(id)
    }
    if (!enabled || !visible || document.hidden || !ids.size) {
      setThumbnails({})
      return
    }

    const controller = new AbortController()
    const { signal } = controller
    const urls = new Set<string>()
    const display = (blob: Blob): Thumbnail => {
      const url = URL.createObjectURL(blob)
      urls.add(url)
      return { status: 'ready', url }
    }
    const stop = () => {
      controller.abort()
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
    const hide = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', stop)
    const pending: string[] = []
    const initial: Record<string, Thumbnail> = {}
    for (const id of ids) {
      const cached = images.get(id)
      initial[id] = cached ? display(cached) : { status: 'loading' }
      if (!cached) pending.push(id)
    }
    setThumbnails(initial)

    const update = (id: string, thumbnail: Thumbnail) => {
      setThumbnails(current => signal.aborted ? current : { ...current, [id]: thumbnail })
    }
    let cursor = 0
    const worker = async () => {
      while (!signal.aborted && !document.hidden && cursor < pending.length) {
        const id = pending[cursor++]!
        try {
          const original = await fetchImage(id, signal)
          if (signal.aborted) return
          const blob = await downsize(original)
          if (signal.aborted) return
          images.set(id, blob)
          update(id, display(blob))
        } catch {
          if (!signal.aborted) update(id, { status: 'error' })
        }
      }
    }
    for (let index = 0; index < Math.min(3, pending.length); index++) void worker()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', stop)
    }
  }, [items, enabled, visible, fetchImage])

  return thumbnails
}
