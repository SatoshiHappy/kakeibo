// まだ作っていない画面(次の一手 5 で 1 枚ずつ置き換える。見本はモック 14 版)
import { Screen, TopBar, type TopBarLeft } from '../components/Shell'

export function Placeholder({ title, left, tabs }: { title: string; left?: TopBarLeft; tabs: boolean }) {
  return (
    <Screen label={title} tabs={tabs} top={<TopBar title={title} left={left} />}>
      <p className="note">この画面は準備中です。</p>
    </Screen>
  )
}
