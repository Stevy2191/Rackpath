// IPAM forms: spaces, prefixes, ranges and addresses.
import { useEffect, useState } from 'react';
import { api, qs } from '../../api';
import type { Device, IpAddress, IpRange, ListedPort, Prefix, Space, Vlan } from '../../types';
import { Checkbox, FormModal, SelectField, TextArea, TextField, Warnings, useLoad } from '../../ui';
import { num, useForm } from '../places/common';

export const PREFIX_ROLES = ['users', 'servers', 'management', 'voice', 'printers', 'iot', 'guest', 'transit', 'wan', 'loopback', 'other'];
export const ADDRESS_ROLES = ['primary', 'secondary', 'gateway', 'vip', 'loopback'];
export const RANGE_KINDS = [
  { value: 'dhcp_pool', label: 'DHCP pool' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'static', label: 'Static assignments' },
];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1).replace('_', ' ');

export function useSpaces(projectId: number) {
  return useLoad(() => api.get<{ spaces: Space[] }>(`/api/projects/${projectId}/spaces`).then((r) => r.spaces), [projectId]);
}
export function useVlans(projectId: number) {
  return useLoad(() => api.get<{ vlans: Vlan[] }>(`/api/projects/${projectId}/vlans`).then((r) => r.vlans), [projectId]);
}

/** Shows a save's warnings and keeps the form open once, so they're read. */
function useWarnings() {
  const [warnings, setWarnings] = useState<string[] | undefined>();
  const keepOpen = (w?: string[]) => {
    if (w?.length && !warnings) {
      setWarnings(w);
      return true;
    }
    return false;
  };
  return { warnings, keepOpen };
}

export function SpaceForm({ projectId, existing, onClose, onSaved }: { projectId: number; existing?: Space; onClose: () => void; onSaved: () => void }) {
  const f = useForm({ name: existing?.name ?? '', description: existing?.description ?? '' });
  return (
    <FormModal
      title={existing ? `Edit space ${existing.name}` : 'Add address space'}
      onClose={onClose}
      onSubmit={async () => {
        if (existing) await api.patch(`/api/spaces/${existing.id}`, f.values);
        else await api.post(`/api/projects/${projectId}/spaces`, f.values);
        onSaved();
      }}
    >
      <p className="small muted">Add a space only when the same private range really exists twice, in separate routing domains.</p>
      <TextField label="Name" required {...f.bind('name')} />
      <TextField label="Description" {...f.bind('description')} />
    </FormModal>
  );
}

export function PrefixForm({ projectId, existing, initialCidr, onClose, onSaved }: { projectId: number; existing?: Prefix; initialCidr?: string; onClose: () => void; onSaved: (p: Prefix) => void }) {
  const spaces = useSpaces(projectId);
  const vlans = useVlans(projectId);
  const { warnings, keepOpen } = useWarnings();
  const f = useForm({
    cidr: existing?.cidr ?? initialCidr ?? '',
    space_id: existing ? String(existing.space_id) : '',
    role: existing?.role ?? 'users',
    status: existing?.status ?? 'active',
    vlan_id: existing?.vlan_id != null ? String(existing.vlan_id) : '',
    gateway: existing?.gateway ?? '',
    dns_servers: existing?.dns_servers ?? '',
    domain_name: existing?.domain_name ?? '',
    description: existing?.description ?? '',
    notes: existing?.notes ?? '',
  });
  const v = f.values;
  return (
    <FormModal
      title={existing ? `Edit ${existing.cidr}` : 'Add prefix'}
      wide
      onClose={onClose}
      onSubmit={async () => {
        const body = { ...v, space_id: num(v.space_id) ?? undefined, vlan_id: num(v.vlan_id) };
        const saved = existing
          ? await api.patch<Prefix & { warnings?: string[] }>(`/api/prefixes/${existing.id}`, body)
          : await api.post<Prefix & { warnings?: string[] }>(`/api/projects/${projectId}/prefixes`, body);
        onSaved(saved);
        if (keepOpen(saved.warnings)) return false;
      }}
    >
      <Warnings items={warnings} />
      <div className="grid-3">
        <TextField label="Prefix (CIDR)" required placeholder="10.20.30.0/24" className="input mono" {...f.bind('cidr')} />
        {(spaces.data?.length ?? 0) > 1 && (
          <SelectField label="Address space" {...f.bind('space_id')} options={[{ value: '', label: 'Default' }, ...(spaces.data ?? []).filter((s) => !s.is_default).map((s) => ({ value: String(s.id), label: s.name }))]} />
        )}
        <SelectField label="Role" {...f.bind('role')} options={PREFIX_ROLES.map((r) => ({ value: r, label: cap(r) }))} />
        <SelectField label="Status" {...f.bind('status')} options={['planned', 'active', 'deprecated'].map((r) => ({ value: r, label: cap(r) }))} />
        <SelectField label="VLAN" {...f.bind('vlan_id')} options={[{ value: '', label: 'None' }, ...(vlans.data ?? []).map((x) => ({ value: String(x.id), label: `${x.vid} ${x.name}` }))]} />
        <TextField label="Gateway" placeholder="10.20.30.1" className="input mono" {...f.bind('gateway')} />
        <TextField label="DNS servers" placeholder="10.0.0.10, 10.0.0.11" {...f.bind('dns_servers')} />
        <TextField label="Domain name" {...f.bind('domain_name')} />
        <TextField label="Description" {...f.bind('description')} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}

export function RangeForm({ prefixId, existing, onClose, onSaved }: { prefixId: number; existing?: IpRange; onClose: () => void; onSaved: () => void }) {
  const { warnings, keepOpen } = useWarnings();
  const f = useForm({
    start: existing?.start_text ?? '',
    end: existing?.end_text ?? '',
    kind: existing?.kind ?? 'dhcp_pool',
    description: existing?.description ?? '',
  });
  return (
    <FormModal
      title={existing ? 'Edit range' : 'Add range'}
      onClose={onClose}
      onSubmit={async () => {
        const r = existing
          ? await api.patch<{ warnings?: string[] }>(`/api/ranges/${existing.id}`, f.values)
          : await api.post<{ warnings?: string[] }>(`/api/prefixes/${prefixId}/ranges`, f.values);
        onSaved();
        if (keepOpen(r.warnings)) return false;
      }}
    >
      <Warnings items={warnings} />
      <div className="grid-2">
        <TextField label="First address" required className="input mono" {...f.bind('start')} />
        <TextField label="Last address" required className="input mono" {...f.bind('end')} />
        <SelectField label="Kind" {...f.bind('kind')} options={RANGE_KINDS} />
        <TextField label="Description" {...f.bind('description')} />
      </div>
    </FormModal>
  );
}

/** A device and optionally one of its ports. */
function DevicePortPicker({ projectId, deviceId, portId, onChange }: { projectId: number; deviceId: string; portId: string; onChange: (device: string, port: string) => void }) {
  const [q, setQ] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [ports, setPorts] = useState<ListedPort[]>([]);
  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get<{ devices: Device[] }>(`/api/projects/${projectId}/devices${qs({ q, limit: 50 })}`)
        .then((r) => setDevices(r.devices), () => setDevices([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, projectId]);
  useEffect(() => {
    if (!deviceId) return setPorts([]);
    api.get<{ ports: ListedPort[] }>(`/api/devices/${deviceId}/ports`).then((r) => setPorts(r.ports.filter((p) => p.medium !== 'power')), () => setPorts([]));
  }, [deviceId]);
  const current = devices.find((d) => String(d.id) === deviceId);
  return (
    <>
      <TextField label="Find a device" placeholder="Code, name, hostname…" value={q} onChange={(e) => setQ(e.target.value)} />
      <SelectField
        label="Device"
        value={deviceId}
        onChange={(e) => onChange(e.target.value, '')}
        options={[
          { value: '', label: 'None (not linked to a device)' },
          ...(deviceId && !current ? [{ value: deviceId, label: 'Current device' }] : []),
          ...devices.map((d) => ({ value: String(d.id), label: d.path.split('/').slice(1).join(' / ') })),
        ]}
      />
      {deviceId && (
        <SelectField
          label="Port"
          value={portId}
          onChange={(e) => onChange(deviceId, e.target.value)}
          options={[{ value: '', label: 'Not on a particular port' }, ...ports.map((p) => ({ value: String(p.id), label: `${p.code}${p.interface_name ? ` (${p.interface_name})` : ''}` }))]}
        />
      )}
    </>
  );
}

export function AddressForm({
  projectId,
  existing,
  prefixId,
  address,
  deviceId,
  onClose,
  onSaved,
}: {
  projectId: number;
  existing?: IpAddress;
  prefixId?: number;
  address?: string;
  deviceId?: number;
  onClose: () => void;
  onSaved: (a: IpAddress) => void;
}) {
  const { warnings, keepOpen } = useWarnings();
  const f = useForm({
    address: existing?.address ?? address ?? '',
    device_id: String(existing?.device_id ?? deviceId ?? ''),
    port_id: String(existing?.port_id ?? ''),
    role: existing?.role ?? 'primary',
    status: existing?.status ?? 'assigned',
    mac: existing?.mac ?? '',
    dns_name: existing?.dns_name ?? '',
    dns_aliases: existing?.dns_aliases.join(', ') ?? '',
    dhcp_reservation: existing?.dhcp_reservation ?? false,
    description: existing?.description ?? '',
    notes: existing?.notes ?? '',
  });
  const v = f.values;
  return (
    <FormModal
      title={existing ? `Edit ${existing.address}` : 'Add IP address'}
      wide
      onClose={onClose}
      onSubmit={async () => {
        const body = {
          ...v,
          address: v.address || undefined,
          prefix_id: !existing && !v.address ? prefixId : undefined,
          device_id: num(v.device_id),
          port_id: num(v.port_id),
          mac: v.mac || null,
          dns_aliases: v.dns_aliases.split(',').map((x) => x.trim()).filter(Boolean),
        };
        const saved = existing
          ? await api.patch<IpAddress & { warnings?: string[] }>(`/api/addresses/${existing.id}`, body)
          : await api.post<IpAddress & { warnings?: string[] }>(`/api/projects/${projectId}/addresses`, body);
        onSaved(saved);
        if (keepOpen(saved.warnings)) return false;
      }}
    >
      <Warnings items={warnings} />
      <div className="grid-3">
        <TextField
          label="Address"
          className="input mono"
          required={!prefixId}
          hint={!existing && prefixId ? 'Blank takes the next free one' : undefined}
          {...f.bind('address')}
        />
        <SelectField label="Role" {...f.bind('role')} options={ADDRESS_ROLES.map((r) => ({ value: r, label: r === 'vip' ? 'Virtual IP' : cap(r) }))} />
        <SelectField label="Status" {...f.bind('status')} options={['reserved', 'assigned', 'deprecated'].map((r) => ({ value: r, label: cap(r) }))} />
        <DevicePortPicker
          projectId={projectId}
          deviceId={v.device_id}
          portId={v.port_id}
          onChange={(d, p) => f.setValues((s) => ({ ...s, device_id: d, port_id: p }))}
        />
        <TextField label="DNS name" placeholder="host.example.lan" {...f.bind('dns_name')} />
        <TextField label="DNS aliases" hint="Comma-separated" {...f.bind('dns_aliases')} />
        <TextField label="MAC address" className="input mono" {...f.bind('mac')} />
        <TextField label="Description" {...f.bind('description')} />
      </div>
      <Checkbox label="DHCP reservation" checked={v.dhcp_reservation} onChange={(c) => f.set('dhcp_reservation', c)} />
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}
