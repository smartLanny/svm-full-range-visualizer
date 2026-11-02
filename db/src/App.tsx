import React, { useEffect, useMemo, useState } from 'react';
import { formatRoute, legacyRoute, parseRoute, type Route } from './lib/route';
import { loadCatalog, useAsync } from './lib/data';
import { Shell } from './components/Shell';
import { Home } from './pages/Home';
import { DevicePage } from './pages/DevicePage';
import { ComparePage } from './pages/ComparePage';
import { Loading, Missing } from './components/ui';

function useRoute(): Route {
  const [hash, setHash] = useState(() => {
    // Old phone-screen-atlas links (?phone=…&compare=…) are rewritten once, without a reload.
    const legacy = legacyRoute(window.location.search, window.location.hash);
    if (legacy) {
      const h = formatRoute(legacy);
      window.history.replaceState(null, '', `${window.location.pathname}${h}`);
      return h;
    }
    return window.location.hash;
  });
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return useMemo(() => parseRoute(hash), [hash]);
}

export function App() {
  const route = useRoute();
  const catalog = useAsync(loadCatalog, 'catalog');
  const pageKey = route.page === 'device' ? `d:${route.id}` : route.page === 'compare' ? `c:${route.ids.join(',')}` : route.page;

  // New page: start at the top (a section route scrolls itself once its data is there).
  useEffect(() => {
    if (!(route.page === 'device' && route.section)) window.scrollTo(0, 0);
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (catalog.status !== 'ready') return;
    const name = (id: string) => catalog.data.devices.find((d) => d.id === id)?.name.zh ?? id;
    document.title =
      route.page === 'device'
        ? `${name(route.id)} · 屏幕数据库`
        : route.page === 'compare'
          ? `${route.ids.map(name).join(' vs ')} · 屏幕数据库`
          : '屏幕数据库 · 野生的装机宅';
  }, [route, catalog]);

  let body: React.ReactNode;
  if (catalog.status === 'loading') body = <Loading className="mt-24 h-[60vh]" />;
  else if (catalog.status === 'error')
    body = <Missing className="mt-24" text="机型目录加载失败" detail={`data/devices.json 没有加载成功（${catalog.error}）。请刷新重试。`} />;
  else if (route.page === 'home') body = <Home catalog={catalog.data} q={route.q} has={route.has} />;
  else if (route.page === 'device') body = <DevicePage key={route.id} catalog={catalog.data} id={route.id} section={route.section} />;
  else if (route.page === 'compare') body = <ComparePage catalog={catalog.data} ids={route.ids} />;
  else
    body = (
      <Missing
        className="mt-24"
        text="没有这个页面"
        detail={
          <a className="text-accent-hover hover:underline" href="#/">
            回到全部机型
          </a>
        }
      />
    );

  return <Shell route={route}>{body}</Shell>;
}
