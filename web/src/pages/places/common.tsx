// Shared bits for the location → floor → room → rack pages.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { DeviceType, TemplateSummary } from '../../types';
import { Checkbox, FormModal, TextField, useLoad } from '../../ui';

/** Breadcrumbs from a server path ("PROJ/LOC/FL/ROOM"), linking the
 * segments whose pages are known. The first segment (project) is skipped. */
export function Crumbs({ path, links }: { path?: string; links: (string | undefined)[] }) {
  if (!path) return null;
  const parts = path.split('/').slice(1);
  return (
    <nav className="crumbs" aria-label="Breadcrumbs">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span aria-hidden> / </span>}
          {links[i] && i < parts.length - 1 ? <Link to={links[i]!}>{p}</Link> : <span>{p}</span>}
        </span>
      ))}
    </nav>
  );
}

/** Simple form state: `bind('name')` gives value and onChange for an input. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const set = <K extends keyof T>(k: K, v: T[K]) => setValues((s) => ({ ...s, [k]: v }));
  const bind = (k: keyof T & string) => ({
    name: k,
    value: (values[k] ?? '') as string | number,
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as T[typeof k]),
  });
  return { values, set, bind, setValues };
}

/** "" → null, numeric strings → numbers. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Deletes a location, floor, room or rack: the user types its code, and
 * chooses what happens to devices inside. */
export function DeleteModal({
  kind,
  code,
  url,
  devices,
  onClose,
  onDone,
}: {
  kind: string;
  code: string;
  url: string;
  devices: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [deleteDevices, setDeleteDevices] = useState(false);
  return (
    <FormModal
      title={`Delete ${kind} ${code}`}
      submitLabel="Delete"
      danger
      onClose={onClose}
      onSubmit={async () => {
        if (typed.trim().toUpperCase() !== code.toUpperCase()) throw new Error(`Type ${code} to confirm`);
        await api.del(url, { confirm_code: typed, devices: devices > 0 ? (deleteDevices ? 'delete' : 'unplace') : undefined });
        onDone();
      }}
    >
      <p>
        This deletes the {kind} and everything in it.
        {devices > 0 && ` It holds ${devices} device(s); they move to the Unplaced list unless you delete them too.`}
      </p>
      {devices > 0 && <Checkbox label="Delete the devices too" checked={deleteDevices} onChange={setDeleteDevices} />}
      <TextField label={`Type ${code} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
    </FormModal>
  );
}

export function useDeviceTypes(projectId: number) {
  return useLoad(() => api.get<DeviceType[]>(`/api/projects/${projectId}/device-types`), [projectId]);
}

export function useTemplates(projectId: number) {
  return useLoad(
    () => api.get<{ templates: TemplateSummary[] }>(`/api/projects/${projectId}/templates`).then((r) => r.templates),
    [projectId],
  );
}

export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (shown.length === 0) return <p className="muted small">No details recorded.</p>;
  return (
    <dl className="kv">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
