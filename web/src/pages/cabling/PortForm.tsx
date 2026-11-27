// Adding ports (one, or many numbered ones) and editing a port.
import { api } from '../../api';
import type { Port } from '../../types';
import { Trash2 } from 'lucide-react';
import { Button, Checkbox, FormModal, SelectField, TextArea, TextField } from '../../ui';
import { num, useForm } from '../places/common';
import { useMedia } from './media';

type Values = {
  code: string;
  interface_name: string;
  role: string;
  face: string;
  connector: string;
  transceiver: string;
  speed: string;
  poe: string;
  mac: string;
  description: string;
  requires_permanent: boolean;
  notes: string;
};

function initial(p?: Port): Values {
  return {
    code: p?.code ?? '',
    interface_name: p?.interface_name ?? '',
    role: p?.role ?? '',
    face: p?.face ?? 'front',
    connector: p?.connector ?? '',
    transceiver: p?.transceiver ?? '',
    speed: p?.speed != null ? String(p.speed) : '',
    poe: p?.poe ?? '',
    mac: p?.mac ?? '',
    description: p?.description ?? '',
    requires_permanent: p?.requires_permanent ?? true,
    notes: p?.notes ?? '',
  };
}

function body(v: Values) {
  return {
    interface_name: v.interface_name,
    role: v.role || undefined,
    face: v.face,
    connector: v.connector || undefined,
    transceiver: v.transceiver || null,
    speed: num(v.speed),
    poe: v.poe || null,
    mac: v.mac || null,
    description: v.description,
    requires_permanent: v.role === 'passive' ? v.requires_permanent : undefined,
    notes: v.notes,
  };
}

function MediaFields({ f }: { f: ReturnType<typeof useForm<Values>> }) {
  const media = useMedia();
  const v = f.values;
  const conn = media?.connectors.find((c) => c.name === v.connector);
  const modules = media?.transceivers.filter((t) => conn?.cage && t.cage === v.connector) ?? [];
  return (
    <>
      <div className="grid-3">
        <SelectField
          label="Role"
          {...f.bind('role')}
          options={[
            { value: '', label: 'Usual for the device type' },
            { value: 'active', label: 'Active (switch port, NIC)' },
            { value: 'passive', label: 'Passive (panel, outlet)' },
          ]}
        />
        <SelectField
          label="Connector"
          {...f.bind('connector')}
          options={[
            { value: '', label: 'Usual for the device type' },
            ...(media?.connectors.filter((c) => !c.media.includes('power')).map((c) => ({ value: c.name, label: c.name })) ?? []),
          ]}
        />
        {conn?.cage && (
          <SelectField
            label="Module"
            {...f.bind('transceiver')}
            options={[{ value: '', label: 'Empty cage' }, ...modules.map((t) => ({ value: t.name, label: t.name }))]}
          />
        )}
        <TextField label="Speed (Mb/s)" type="number" min={1} hint="Blank to follow the module or connector" {...f.bind('speed')} />
        <SelectField
          label="PoE"
          {...f.bind('poe')}
          options={[
            { value: '', label: 'None' },
            { value: 'af', label: '802.3af (15 W)' },
            { value: 'at', label: '802.3at (30 W)' },
            { value: 'bt', label: '802.3bt (60–90 W)' },
            { value: 'passive', label: 'Passive' },
          ]}
        />
        <SelectField label="On the device's" {...f.bind('face')} options={[{ value: 'front', label: 'Front' }, { value: 'rear', label: 'Rear' }]} />
      </div>
      {v.role === 'passive' && (
        <Checkbox
          label="Needs a permanent cable on its rear before it can be patched"
          hint="Untick for couplers and pass-throughs"
          checked={v.requires_permanent}
          onChange={(c) => f.set('requires_permanent', c)}
        />
      )}
    </>
  );
}

export function PortForm({ deviceId, existing, onClose, onSaved, onDelete }: { deviceId: number; existing?: Port; onClose: () => void; onSaved: () => void; onDelete?: () => void }) {
  const f = useForm<Values>(initial(existing));
  return (
    <FormModal
      title={existing ? `Edit port ${existing.code}` : 'Add port'}
      wide
      onClose={onClose}
      onSubmit={async () => {
        const b = { ...body(f.values), code: f.values.code };
        if (existing) await api.patch(`/api/ports/${existing.id}`, b);
        else await api.post(`/api/devices/${deviceId}/ports`, b);
        onSaved();
      }}
    >
      <div className="grid-3">
        <TextField label="Port" required maxLength={10} hint="e.g. 01 or G24; up to 10 characters" {...f.bind('code')} />
        <TextField label="Interface name" placeholder="e.g. Gi1/0/24" {...f.bind('interface_name')} />
        <TextField label="MAC address" {...f.bind('mac')} />
      </div>
      <MediaFields f={f} />
      <TextField label="Description" {...f.bind('description')} />
      <TextArea label="Notes" {...f.bind('notes')} />
      {existing && onDelete && (
        <Button variant="danger" icon={<Trash2 size={15} />} onClick={onDelete}>
          Delete port {existing.code}
        </Button>
      )}
    </FormModal>
  );
}

export function BulkPortsForm({ deviceId, onClose, onSaved }: { deviceId: number; onClose: () => void; onSaved: (count: number) => void }) {
  const f = useForm<Values>(initial());
  const extra = useForm({ prefix: '', start: '1', count: '24' });
  const n = Number(extra.values.count) || 0;
  const first = Number(extra.values.start) || 1;
  const width = String(first + n - 1).length;
  const sample = (i: number) => `${extra.values.prefix}${String(i).padStart(width, '0')}`;
  return (
    <FormModal
      title="Add numbered ports"
      wide
      onClose={onClose}
      onSubmit={async () => {
        await api.post(`/api/devices/${deviceId}/ports/bulk`, {
          ...body(f.values),
          prefix: extra.values.prefix,
          start: first,
          count: n,
        });
        onSaved(n);
      }}
    >
      <div className="grid-3">
        <TextField label="Text before the number" placeholder="e.g. G or Te1/0/" {...extra.bind('prefix')} />
        <TextField label="First number" type="number" min={0} {...extra.bind('start')} />
        <TextField label="How many" type="number" min={1} max={512} required {...extra.bind('count')} />
      </div>
      {n > 0 && <p className="small muted">Creates {sample(first)}{n > 1 ? ` … ${sample(first + n - 1)}` : ''}.</p>}
      <MediaFields f={f} />
    </FormModal>
  );
}
