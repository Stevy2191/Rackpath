import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search as SearchIcon } from 'lucide-react';
import { api, qs } from '../api';
import { hitLink } from '../links';
import type { SearchHit } from '../types';
import { Badge } from '../ui';

/** Global search: codes, paths, names, hostnames, MACs, serials, IP
 * addresses and prefixes. Ctrl-K (or /) focuses it. */
export function Search({ projectId }: { projectId?: number }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select');
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const base = await api.get<SearchHit[]>(`/api/search${qs({ q: text, project_id: projectId, limit: 20 })}`);
        // Ports are only searched when asked for; add them when few others match.
        let ports: SearchHit[] = [];
        if (base.length < 5) ports = await api.get<SearchHit[]>(`/api/search${qs({ q: text, project_id: projectId, kind: 'port', limit: 10 })}`);
        setHits([...base, ...ports]);
        setActive(0);
      } catch {
        setHits([]);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q, projectId]);

  const go = (h: SearchHit) => {
    setOpen(false);
    setQ('');
    nav(hitLink(h));
  };

  return (
    <div className="search">
      <SearchIcon size={16} />
      <input
        ref={input}
        className="input"
        placeholder="Search codes, paths, IPs, MACs, serials…  (Ctrl K)"
        value={q}
        aria-label="Search"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, hits.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter' && hits[active]) go(hits[active]);
          else if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
      />
      {open && q.trim() && (
        <div className="search-results">
          {hits.length === 0 && <div className="search-hit muted">No matches</div>}
          {hits.map((h, i) => (
            <div
              key={`${h.kind}-${h.id}`}
              className={`search-hit${i === active ? ' active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                go(h);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="kind">
                <Badge>{h.kind}</Badge>
              </span>
              <span>
                <div className="path">
                  {h.path}
                  {h.name && <span className="muted"> · {h.name}</span>}
                </div>
                {h.detail && <div className="detail">→ {h.detail}</div>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
