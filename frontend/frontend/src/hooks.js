import { useCallback, useEffect, useState } from 'react';
import { api, errText } from './api.js';
export function useGet(path, deps = []) {
  const [s, set] = useState({ data: null, err: null, loading: true });
  const load = useCallback(() => {
    let live = true; set(x => ({ ...x, loading: true, err: null }));
    api(path).then(data => live && set({ data, err: null, loading: false })).catch(e => live && set({ data: null, err: errText(e), loading: false }));
    return () => { live = false; };
  }, [path]); // eslint-disable-line
  useEffect(load, [load, ...deps]);
  return { ...s, reload: load };
}
