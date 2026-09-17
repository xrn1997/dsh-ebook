import type { ReactNode } from 'react'
import { routeStore, useStore } from '../store.js'
import { NovelStyles } from '../styles.js'
import { ReaderView } from './ReaderView.js'
import { SearchView } from './SearchView.js'
import { ShelfView } from './ShelfView.js'

/** 「小说」view 根：按 routeStore 分发三分支（reader/search/默认 shelf 兜底）；样式层全局注入一次。
 * 三级导航收敛：「小说」tab 打开即首页——居中搜索框 + 封面网格；tab 栏已退役。
 *  布局钉死：根 = flex 列；视图区（flex:1 + overflowY:auto）——此前 height:100% 挤出视口的坑见 21a5432。 */
export function NovelView(): ReactNode {
  const { route } = useStore(routeStore)
  return (
    <div data-novel data-novel-root data-novel-scope className="novel-root">
      <NovelStyles />
      <div data-novel-main className="novel-main">
        {route.name === 'reader'
          ? <ReaderView sourceId={route.sourceId} bookKey={route.bookKey} title={route.title} />
          : route.name === 'search'
            ? <SearchView />
            : <ShelfView />}
      </div>
    </div>
  )
}
