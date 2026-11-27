// Adding a cable from a port to another, and changing or removing one.
import { useEffect, useState } from 'react';
import { api, qs } from '../../api';
import type { Connection, Device, ListedPort } from '../../types';
import { Button, FormModal, SelectField, TextArea, TextField, Warnings, useToast } from '../../ui';
import { num, useForm } from '../places/common';
import { useMedia } from './media';

type Side = 'front' | 'rear';

/** Sides of a port that are free for a cable. */
export function freeSides(p: ListedPort): Side[] {
  if (p.role === 'active') return p.front ? [] : ['front'];
  // A panel port is patched only once its permanent cable is in.
  const frontOk = !p.front && (!p.requires_permanent || !!p.rear);
  return [...(frontOk ? ['front' as Side] : []), ...(p.rear ? [] : ['rear' as Side])];
}

export function ConnectForm({
  projectId,
  from,
  side,
  onClose,
  onSaved,
}: {
  projectId: number;
  from: ListedPort;
  side?: Side;
  onClose: () => void;
  onSaved: (c: Connection) => void;
}) {
  const media = useMedia();
  const toast = useToast();
  const sides = freeSides(from);
  const [q, setQ] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [ports, setPorts] = useState<ListedPort[] | null>(null);
  // Permanent cables join the rear sides of passive ports; patch cords
  // plug into front sides.
  const kinds = from.role === 'passive' ? sides.map((x) => (x === 'rear' ? 'permanent' : 'patch')) : ['patch'];
  const f = useForm({
    kind: side === 'rear' ? 'permanent' : side === 'front' ? 'patch' : kinds[0],
    device_id: '',
    port_id: '',
    cable_type: '',
    length_m: '',
    color: '',
    label: '',
    notes: '',
  });
  const v = f.values;
  const wanted: Side = v.kind === 'permanent' ? 'rear' : 'front';

  // Devices matching the search (all of the project's when empty).
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get<{ devices: Device[] }>(`/api/projects/${projectId}/devices${qs({ q, limit: 50 })}`)
        .then((r) => setDevices(r.devices.filter((d) => d.placement.type !== 'unplaced')))
        .catch(() => setDevices([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, projectId]);

  const deviceId = devices.some((d) => String(d.id) === v.device_id) ? v.device_id : String(devices[0]?.id ?? '');
  useEffect(() => {
    setPorts(null);
    if (!deviceId) return;
    api.get<{ ports: ListedPort[] }>(`/api/devices/${deviceId}/ports`).then(
      (r) => setPorts(r.ports.filter((p) => p.medium !== 'power' && p.id !== from.id)),
      () => setPorts([]),
    );
  }, [deviceId, from.id]);

  const usable = (ports ?? []).filter((p) => freeSides(p).includes(wanted) && (wanted === 'front' || p.role === 'passive'));
  const target = usable.find((p) => String(p.id) === v.port_id) ?? usable[0];

  return (
    <FormModal
      title={`Connect ${from.path.split('/').slice(-2).join(' ')}`}
      wide
      submitLabel="Connect"
      onClose={onClose}
      onSubmit={async () => {
        if (!target) throw new Error('Choose a port to connect to');
        const c = await api.post<Connection>('/api/connections', {
          kind: v.kind,
          a: { port_id: from.id, side: from.role === 'passive' ? wanted : undefined },
          b: { port_id: target.id, side: target.role === 'passive' ? wanted : undefined },
          cable_type: v.cable_type || undefined,
          length_m: num(v.length_m) ?? undefined,
          color: v.color || undefined,
          label: v.label,
          notes: v.notes,
        });
        if (c.warnings?.length) toast.warn(`Connected, but: ${c.warnings.join(' ')}`);
        onSaved(c);
      }}
    >
      <div className="grid-2">
        <SelectField
          label="Cable"
          {...f.bind('kind')}
          options={kinds.map((k) => ({ value: k, label: k === 'permanent' ? 'Permanent, rear to rear (structured cabling)' : 'Patch cord, front' }))}
        />
        <TextField label="Find a device" placeholder="Code, name, hostname…" value={q} onChange={(e) => setQ(e.target.value)} />
        <SelectField
          label="Device"
          value={deviceId}
          onChange={(e) => {
            f.set('device_id', e.target.value);
            f.set('port_id', '');
          }}
          options={devices.map((d) => ({ value: String(d.id), label: d.path.split('/').slice(1).join(' / ') }))}
        />
        <SelectField
          label="Port"
          value={target ? String(target.id) : ''}
          onChange={(e) => f.set('port_id', e.target.value)}
          options={
            ports === null
              ? [{ value: '', label: 'Loading…' }]
              : usable.length === 0
                ? [{ value: '', label: wanted === 'rear' ? 'No passive port with a free rear' : 'No free ports' }]
                : usable.map((p) => ({ value: String(p.id), label: `${p.code}${p.interface_name ? ` (${p.interface_name})` : ''} · ${p.transceiver ?? p.connector ?? p.medium}` }))
          }
        />
        <SelectField
          label="Cable type"
          {...f.bind('cable_type')}
          options={[{ value: '', label: 'Not recorded' }, ...(media?.cable_types.filter((c) => c !== 'Power cord' && c !== 'Battery cable').map((c) => ({ value: c, label: c })) ?? [])]}
        />
        <TextField label="Length (m)" type="number" min={0} step="any" {...f.bind('length_m')} />
        <TextField label="Colour" placeholder="#1e90ff" {...f.bind('color')} />
        <TextField label="Label" {...f.bind('label')} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}

export function CableEdit({ id, onClose, onSaved }: { id: number; onClose: () => void; onSaved: () => void }) {
  const media = useMedia();
  const toast = useToast();
  const [c, setC] = useState<Connection | null>(null);
  const [arm, setArm] = useState(false);
  const f = useForm({ cable_type: '', length_m: '', color: '', label: '', notes: '' });
  const setValues = f.setValues;
  useEffect(() => {
    api.get<Connection>(`/api/connections/${id}`).then((c) => {
      setC(c);
      setValues({
        cable_type: c.cable_type ?? '',
        length_m: c.length_m != null ? String(c.length_m) : '',
        color: c.color ?? '',
        label: c.label ?? '',
        notes: c.notes ?? '',
      });
    }, toast.error);
  }, [id, setValues]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null;
  const [warnings, setWarnings] = [c.warnings, (w: string[]) => setC({ ...c, warnings: w })];
  return (
    <FormModal
      title={`Cable ${c.label ?? `#${c.id}`}`}
      onClose={onClose}
      onSubmit={async () => {
        const v = f.values;
        const r = await api.patch<Connection>(`/api/connections/${id}`, {
          cable_type: v.cable_type || null,
          length_m: num(v.length_m),
          color: v.color || null,
          label: v.label,
          notes: v.notes,
        });
        onSaved();
        if (r.warnings?.length) {
          setWarnings(r.warnings);
          return false;
        }
      }}
    >
      <p className="small">
        <span className="mono">{c.a.path.split('/').slice(1).join(' / ')}</span> ({c.a.side}) ↔{' '}
        <span className="mono">{c.b.path.split('/').slice(1).join(' / ')}</span> ({c.b.side}) · {c.kind}
      </p>
      <Warnings items={warnings} />
      <div className="grid-2">
        <SelectField label="Cable type" {...f.bind('cable_type')} options={[{ value: '', label: 'Not recorded' }, ...(media?.cable_types.map((x) => ({ value: x, label: x })) ?? [])]} />
        <TextField label="Length (m)" type="number" min={0} step="any" {...f.bind('length_m')} />
        <TextField label="Colour" placeholder="#1e90ff" {...f.bind('color')} />
        <TextField label="Label" {...f.bind('label')} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
      <Button
        variant="danger"
        onClick={async () => {
          if (!arm) return setArm(true);
          await api.del(`/api/connections/${id}`).then(() => {
            onSaved();
            onClose();
          }, toast.error);
        }}
      >
        {arm ? 'Click again to remove the cable' : 'Remove cable'}
      </Button>
    </FormModal>
  );
}
