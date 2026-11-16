// 送る前の写真の並び(データと照合 §2.1 の前置き)。端末の IndexedDB に置き、「送る」までアプリを閉じても残す

export type TrayPhoto = {
  /** 端末で付ける ID(送信の ID の元) */
  id: string
  blob: Blob
  /** 前の写真の続き(長いレシート)。先頭の写真では見ない */
  cont: boolean
}

/** 写真をレシートに分ける: 写真 1 枚ごとに 1 枚。続きの印は前のレシートに足す。先頭は印があっても新しいレシート */
export function groupPhotos(photos: TrayPhoto[]): TrayPhoto[][] {
  const groups: TrayPhoto[][] = []
  for (const p of photos) {
    const last = groups.at(-1)
    if (p.cont && last) last.push(p)
    else groups.push([p])
  }
  return groups
}

/** 1 枚のレシートの写真の上限(口の MAX_IMAGES と同じ値) */
export const MAX_PHOTOS_PER_RECEIPT = 10

/** この写真に「前の続き」を付けても、どのレシートも上限を超えないか */
export function canContinue(photos: TrayPhoto[], id: string): boolean {
  return groupPhotos(photos.map((p) => (p.id === id ? { ...p, cont: true } : p))).every((g) => g.length <= MAX_PHOTOS_PER_RECEIPT)
}

/** レシート 1 枚の送信の ID = 写真の ID の並びの SHA-256(同じ組み合わせは同じ下書き、変えたら別の下書き) */
export async function requestIdOf(group: TrayPhoto[]): Promise<string> {
  const bytes = new TextEncoder().encode(group.map((p) => p.id).join('\n'))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `tray-${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`
}
