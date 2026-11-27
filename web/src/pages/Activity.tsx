// The change history: who changed what, when, with the before and after.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, qs } from '../api';
import { Button, Empty, ErrorBox, PageHeader, SelectField, Spinner, TextField, fmtTime, message } from '../ui';
import { useProjects } from './admin/Grants';

interface Entry {
  id: number;
  at: string;
  user_id: number | null;
  username: string | null;
  project_id: number | null;
  action: string;
  resource_type: string;
  resource_id: number | null;
  resource_path: string | null;
  changes: Record<string, unknown> | null;
  ip: string | null;
}

const ACTIONS = ['create', 'update', 'delete', 'move', 'connect', 'disconnect', 'grant', 'revoke', 'sync', 'import', 'login', 'login_failed', 'logout'];
const TYPES = [
  'location', 'floor', 'room', 'rack', 'device', 'port', 'connection', 'device_template', 'device_type', 'tag', 'topology',
  'address_space', 'prefix', 'ip_range', 'ip_address', 'vlan', 'wlan', 'integration', 'csv',
  'project', 'user', 'invitation', 'session', 'account', 'account_settings',
];
const words = (s: string) => s.replace(/_/g, ' ');

/** One change as "field: before → after" lines where the API gave pairs. */
function Changes({ changes }: { changes: Record<string, unknown> }) {
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <dl className="kv changes">
      {Object.entries(changes).map(([k, v]) => (
        <div key={k}>
          <dt>{k.replace(/_/g, ' ')}</dt>
          <dd className="mono small">
            {Array.isArray(v) && v.length === 2 && (typeof v[0] !== 'object' || v[0] === null) ? (
              <>
                <del>{show(v[0])}</del> → <ins>{show(v[1])}</ins>
              </>
            ) : (
              show(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ActivityPage() {
  const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const filters = {
    project_id: params.get('project') ?? undefined,
    action: params.get('action') ?? undefined,
    resource_type: params.get('type') ?? undefined,
    from: params.get('from') ? `${params.get('from')}T00:00:00Z` : undefined,
    to: params.get('to') ? `${params.get('to')}T23:59:59Z` : undefined,
  };
  const key = JSON.stringify(filters);
  const load = async (before?: number) => {
    try {
      const r = await api.get<{ entries: Entry[]; next_before_id: number | null }>(`/api/audit${qs({ ...JSON.parse(key), limit: 100, before_id: before })}`);
      setRows((old) => (before ? [...(old ?? []), ...r.entries] : r.entries));
      setNext(r.next_before_id);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    setRows(null);
    load();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div>
      <PageHeader title="Activity" subtitle="Every change, who made it and when" />
      <div className="filters filters-5">
        <SelectField label="Project" value={params.get('project') ?? ''} onChange={(e) => set('project', e.target.value)} options={[{ value: '', label: 'All projects' }, ...(projects.data ?? []).map((p) => ({ value: String(p.id), label: p.name }))]} />
        <SelectField label="Action" value={params.get('action') ?? ''} onChange={(e) => set('action', e.target.value)} options={[{ value: '', label: 'Any action' }, ...ACTIONS.map((a) => ({ value: a, label: words(a) }))]} />
        <SelectField label="Kind of thing" value={params.get('type') ?? ''} onChange={(e) => set('type', e.target.value)} options={[{ value: '', label: 'Anything' }, ...TYPES.map((t) => ({ value: t, label: words(t) }))]} />
        <TextField label="From" type="date" value={params.get('from') ?? ''} onChange={(e) => set('from', e.target.value)} />
        <TextField label="To" type="date" value={params.get('to') ?? ''} onChange={(e) => set('to', e.target.value)} />
      </div>
      <ErrorBox error={error} />
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="Nothing recorded for these filters" />
      ) : (
        <ol className="activity">
          {rows.map((e) => (
            <li key={e.id} data-action={e.action}>
              <button type="button" className="activity-head" onClick={() => toggle(e.id)} aria-expanded={open.has(e.id)} disabled={!e.changes}>
                {e.changes ? open.has(e.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span style={{ width: 14 }} />}
                <span className="small muted mono">{fmtTime(e.at)}</span>
                <strong>{e.username ?? 'system'}</strong>
                <span className={`activity-action a-${e.action}`}>{words(e.action)}</span>
                <span>{e.resource_type.replace(/_/g, ' ')}</span>
                {e.resource_path && <span className="mono small">{e.resource_path}</span>}
              </button>
              {open.has(e.id) && e.changes && <Changes changes={e.changes} />}
            </li>
          ))}
        </ol>
      )}
      {next && <Button onClick={() => load(next)}>Load older</Button>}
    </div>
  );
}
