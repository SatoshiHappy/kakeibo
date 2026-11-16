// 確かめの小窓(押すとすぐ決まる操作・消す・捨てるの前に出す。2026-11-17 ユーザー回答「操作をそろえたい」)
import { useEffect, useId, useRef } from 'react'
import { useModal } from './useModal'

/** 「やめる」を先に置き、そこに目を当てる(続けて押しても決まらない)。danger = 消す・捨てるなど赤い操作 */
export function Confirm(props: { open: boolean; title: string; body: string; action: string; busy: boolean; danger?: boolean; onAction: () => void; onClose: () => void }) {
  const ref = useModal(props.open)
  const titleId = useId()
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (props.open) keep.current?.focus()
  }, [props.open])
  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} onClose={props.onClose}>
      <h2 id={titleId}>{props.title}</h2>
      <p className="note">{props.body}</p>
      <div className="sheet-actions">
        <button ref={keep} className="sbtn" type="button" onClick={props.onClose}>
          やめる
        </button>
        <button className={props.danger ? 'pbtn dangerfill' : 'pbtn'} type="button" disabled={props.busy} onClick={props.onAction}>
          {props.action}
        </button>
      </div>
    </dialog>
  )
}
