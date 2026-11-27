import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ExternalLink, MoveRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, qs } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { Device, IpAddress } from '../../types';
import { PortsPanel } from '../cabling/PortsPanel';
import { Badge, Button, Card, ErrorBox, PageHeader, SelectField, Spinner, Table, Tabs, TextField, fmtTime, message, useLoad, useToast } from '../../ui';
import { Crumbs, DeleteModal, KeyValues, useDeviceTypes } from '../places/common';
import { DeviceEdit, DeviceForm, MoveDevice, STATUSES, type PlaceOption } from './DeviceForm';

export const statusTone = (s: Device['status']) => (s === 'active' ? 'ok' : s === 'faulty' ? 'danger' : s === 'planned' ? 'info' : s === 'spare' ? 'accent' : 'neutral');

/** Where a device is, as a link. */
export function PlacementText({ d, projectId }: { d: Device; projectId: number }) {
  const p = d.placement;
  const parent = d.path.split('/').slice(1, -1).join(' / ');
  if (p.type === 'unplaced') return <span className="muted">Unplaced</span>;
  const to = p.type === 'rack' ? link.rack(projectId, p.rack_id) : p.type === 'room' ? link.room(projectId, p.room_id) : link.device(projectId, p.tray_id);
  const extra = p.type === 'rack' ? (p.mount.startsWith('zero') ? ' · zero-U' : p.u != null ? ` · U${p.u}` : ' · no position') : '';
  return (
    <span>
      <Link to={to}>{parent}</Link>
      {extra}
    </span>
  );
}

const PAGE = 100;

export function DevicesPage() {
  const { project, canWrite } = useProject();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const types = useDeviceTypes(project.id);
  const places = useLoad(() => api.get<PlaceOption[]>(`/api/projects/${project.id}/places`), [project.id]);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [rows, setRows] = useState<Device[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const filters = {
    q: params.get('q') ?? undefined,
    device_type: params.get('type') ?? undefined,
    status: params.get('status') ?? undefined,
    location_id: params.get('location') ?? undefined,
    unplaced: params.get('unplaced') === '1' ? true : undefined,
  };
  const key = JSON.stringify(filters);

  const load = async (after?: number) => {
    try {
      const r = await api.get<{ devices: Device[]; next_after_id: number | null }>(
        `/api/projects/${project.id}/devices${qs({ ...JSON.parse(key), limit: PAGE, after_id: after })}`,
      );
      setRows((old) => (after ? [...(old ?? []), ...r.devices] : r.devices));
      setNext(r.next_after_id);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    setRows(null);
    load();
  }, [project.id, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing filters after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setParam('q', q), 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  function setParam(k: string, v: string) {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    if (p.toString() !== params.toString()) setParams(p, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Devices"
        actions={canWrite && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>Add device</Button>}
      />
      <div className="filters">
        <TextField label="Search" placeholder="Code, name, serial, hostname…" value={q} onChange={(e) => setQ(e.target.value)} />
        <SelectField
          label="Type"
          value={params.get('type') ?? ''}
          onChange={(e) => setParam('type', e.target.value)}
          options={[{ value: '', label: 'Any type' }, ...(types.data ?? []).map((t) => ({ value: t.key, label: t.label }))]}
        />
        <SelectField
          label="Status"
          value={params.get('status') ?? ''}
          onChange={(e) => setParam('status', e.target.value)}
          options={[{ value: '', label: 'Any status' }, ...STATUSES.map((s) => ({ value: s, label: s }))]}
        />
        <SelectField
          label="Where"
          value={params.get('unplaced') === '1' ? 'unplaced' : (params.get('location') ?? '')}
          onChange={(e) => {
            const p = new URLSearchParams(params);
            p.delete('location');
            p.delete('unplaced');
            if (e.target.value === 'unplaced') p.set('unplaced', '1');
            else if (e.target.value) p.set('location', e.target.value);
            setParams(p, { replace: true });
          }}
          options={[
            { value: '', label: 'Anywhere' },
            { value: 'unplaced', label: 'Unplaced' },
            ...(places.data ?? []).filter((x) => x.kind === 'location').map((x) => ({ value: String(x.id), label: x.path.split('/').slice(1).join(' / ') })),
          ]}
        />
      </div>
      <ErrorBox error={error} onRetry={() => load()} />
      {!rows ? (
        <Spinner />
      ) : (
        <>
          <Table
            rows={rows}
            rowKey={(d) => d.id}
            onRowClick={(d) => nav(link.device(project.id, d.id))}
            empty="No devices match"
            columns={[
              { key: 'code', label: 'Code', render: (d) => <Link to={link.device(project.id, d.id)} className="mono">{d.code}</Link>, sort: (d) => d.code },
              { key: 'name', label: 'Name', render: (d) => d.name, sort: (d) => d.name ?? '' },
              { key: 'type', label: 'Type', render: (d) => d.device_type.label, sort: (d) => d.device_type.label },
              { key: 'where', label: 'Where', render: (d) => <PlacementText d={d} projectId={project.id} />, sort: (d) => d.path },
              { key: 'model', label: 'Model', render: (d) => [d.manufacturer, d.model].filter(Boolean).join(' ') },
              { key: 'status', label: 'Status', render: (d) => <Badge tone={statusTone(d.status)}>{d.status}</Badge>, sort: (d) => d.status },
            ]}
          />
          {next && (
            <div className="row" style={{ justifyContent: 'center', marginTop: '1rem' }}>
              <Button onClick={() => load(next)}>Load more</Button>
            </div>
          )}
        </>
      )}
      {adding && (
        <DeviceForm projectId={project.id} placement={{ type: 'unplaced' }} onClose={() => setAdding(false)} onSaved={(d) => nav(link.device(project.id, d.id))} />
      )}
    </div>
  );
}

export function DevicePage() {
  const { project } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const dev = useLoad(() => api.get<Device>(`/api/devices/${id}`), [id]);
  const [modal, setModal] = useState<'edit' | 'move' | 'delete' | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'overview') as 'overview' | 'ports' | 'addresses';
  if (dev.error) return <ErrorBox error={dev.error} onRetry={dev.reload} />;
  if (!dev.data) return <Spinner />;
  const d = dev.data;
  const p = d.placement;
  const links = p.type === 'rack' ? [undefined, undefined, undefined, link.rack(project.id, p.rack_id)] : p.type === 'room' ? [undefined, undefined, link.room(project.id, p.room_id)] : [];
  return (
    <div>
      <Crumbs path={d.path} links={links} />
      <PageHeader
        title={<><span className="mono">{d.code}</span>{d.name && <span className="title-name"> {d.name}</span>}</>}
        subtitle={<>{d.device_type.label} · <Badge tone={statusTone(d.status)}>{d.status}</Badge></>}
        actions={
          d.can_edit && (
            <>
              <Button icon={<Pencil size={15} />} onClick={() => setModal('edit')}>Edit</Button>
              <Button icon={<MoveRight size={15} />} onClick={() => setModal('move')}>Move</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal('delete')}>Delete</Button>
            </>
          )
        }
      />
      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'ports', label: 'Ports' },
          { id: 'addresses', label: 'IP addresses' },
        ]}
        value={tab}
        onChange={(t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
      />
      <div className="tab-panel">
        {tab === 'overview' && (
          <>
          {d.missing_from_source_at && (
            <div className="error-box" role="status">Not seen by {d.source} since {fmtTime(d.missing_from_source_at)}.</div>
          )}
          <div className="grid-2">
            <Card title="Details">
              <KeyValues
                rows={[
                  ['Where', <PlacementText d={d} projectId={project.id} />],
                  ['Model', [d.manufacturer, d.model].filter(Boolean).join(' ')],
                  ['Height', d.u_height != null ? `${d.u_height}U` : null],
                  ['Serial number', d.serial_number && <span className="mono">{d.serial_number}</span>],
                  ['Asset tag', d.asset_tag],
                  ['Hostname', d.hostname && <span className="mono">{d.hostname}</span>],
                  ['MAC', d.mac && <span className="mono">{d.mac}</span>],
                  ['OS', d.os],
                  ['Firmware', d.firmware],
                  ['Tags', d.tags.length > 0 && <span className="row">{d.tags.map((t) => <Badge key={t.id}>{t.name}</Badge>)}</span>],
                ]}
              />
            </Card>
            <Card title="Lifecycle">
              <KeyValues
                rows={[
                  ['Purchased', d.purchase_date],
                  ['Warranty until', d.warranty_expiry],
                  ['In service since', d.in_service_date],
                  ['Source', d.source !== 'manual' && (d.external_url ? <a href={d.external_url} target="_blank" rel="noreferrer">{d.source} <ExternalLink size={12} /></a> : d.source)],
                  ['Notes', d.notes && <span className="pre">{d.notes}</span>],
                ]}
              />
            </Card>
          </div>
          {d.on_tray && d.on_tray.length > 0 && (
            <Card title="On this shelf" className="mt">
              <ul className="list">
                {d.on_tray.map((c) => (
                  <li key={c.id}>
                    <Link to={link.device(project.id, c.id)} className="mono">{c.code}</Link> {c.name}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          </>
        )}
        {tab === 'ports' && <PortsPanel projectId={project.id} deviceId={d.id} canEdit={!!d.can_edit && d.placement.type !== 'unplaced'} />}
        {tab === 'ports' && d.placement.type === 'unplaced' && <p className="small muted">Unplaced devices can't be cabled; move it into a rack or room first.</p>}
        {tab === 'addresses' && <DeviceAddresses projectId={project.id} deviceId={d.id} />}
      </div>
      {modal === 'edit' && <DeviceEdit device={d} onClose={() => setModal(null)} onSaved={dev.reload} />}
      {modal === 'move' && <MoveDevice device={d} projectId={project.id} onClose={() => setModal(null)} onSaved={dev.reload} />}
      {modal === 'delete' && (
        <DeleteModal
          kind="device"
          code={d.code}
          url={`/api/devices/${d.id}`}
          devices={d.on_tray?.length ?? 0}
          onClose={() => setModal(null)}
          onDone={() => {
            toast.ok(`Deleted ${d.code}`);
            nav(link.devices(project.id));
          }}
        />
      )}
    </div>
  );
}

function DeviceAddresses({ projectId, deviceId }: { projectId: number; deviceId: number }) {
  const list = useLoad(
    () => api.get<{ addresses: IpAddress[] }>(`/api/projects/${projectId}/addresses${qs({ device_id: deviceId, limit: 500 })}`).then((r) => r.addresses),
    [projectId, deviceId],
  );
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Spinner />;
  return (
    <Table
      rows={list.data}
      rowKey={(a) => a.id}
      empty="No IP addresses documented for this device"
      columns={[
        { key: 'address', label: 'Address', render: (a) => <Link to={link.address(projectId, a.id)} className="mono">{a.address}{a.prefix_len != null ? `/${a.prefix_len}` : ''}</Link>, sort: (a) => a.address },
        { key: 'port', label: 'Port', render: (a) => (a.port_id ? <Link to={link.port(projectId, a.port_id)} className="mono">{a.port_path?.split('/').pop()}</Link> : null) },
        { key: 'dns', label: 'DNS name', render: (a) => a.dns_name, sort: (a) => a.dns_name ?? '' },
        { key: 'role', label: 'Role', render: (a) => a.role, sort: (a) => a.role },
        { key: 'status', label: 'Status', render: (a) => a.status, sort: (a) => a.status },
        { key: 'source', label: 'Source', render: (a) => (a.dhcp_reservation ? `${a.source} · DHCP reservation` : a.source) },
      ]}
    />
  );
}
