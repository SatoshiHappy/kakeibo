// <dialog> の開け閉め(確かめの小窓・写真の大きな表示)
import { useEffect, useRef } from 'react'

/** open に合わせて <dialog> を開け閉めする(showModal で前面に出し、裏の画面を押せなくする) */
export function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return ref
}
