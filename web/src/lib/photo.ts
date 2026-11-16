// 撮った写真を長辺 2,000px 以下の JPEG に縮める(データと照合 §2.1 の前置き・要求の画像の見積もり)
// iPhone の HEIC も createImageBitmap で読めるので、出口はいつも JPEG(口は JPEG だけを受ける)

export const MAX_SIDE = 2000
const QUALITY = 0.85

/** 長辺を max 以下にした大きさ(縦横比を保つ。小さい写真は大きくしない) */
export function fitSize(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export async function shrinkToJpeg(file: Blob): Promise<Blob> {
  // 写真の向き(EXIF)は createImageBitmap の既定 imageOrientation: 'from-image' で直る
  const bitmap = await createImageBitmap(file)
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas_2d_unavailable')
    ctx.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
    if (!blob) throw new Error('jpeg_encode_failed')
    return blob
  } finally {
    bitmap.close()
  }
}
