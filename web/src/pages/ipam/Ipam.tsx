// IPAM overview: the prefix tree, every address, warnings and spaces.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { IpAddress, IpamWarning, Prefix, Space } from '../../types';
import { Badge, Button, Empty, ErrorBox, PageHeader, SelectField, Spinner, Table, Tabs, TextField, message, useLoad } from '../../ui';
import { AddressForm, PrefixForm, SpaceForm, useSpaces, useVlans } from './Forms';
import { CsvButton } from '../Exports';

type Tab = 'prefixes' | 'addresses' | 'warnings' | 'spaces';

export function IpamPage() {
  const { project, canWrite } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'prefixes') as Tab;
  const nav = useNavigate();
  const [modal, setModal] = useState<'prefix' | 'address' | null>(null);
  return (
    <div>
      <PageHeader
        title="IP addresses"
        subtitle="Prefixes, ranges and addresses as documented; nothing here pings or scans"
        actions={
          <>
            <CsvButton projectId={project.id} table="prefixes" label="Prefixes CSV" />
            <CsvButton projectId={project.id} table="addresses" label="Addresses CSV" />
            {canWrite && (
              <>
                <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal('prefix')}>Add prefix</Button>
                <Button icon={<Plus size={16} />} onClick={() => setModal('address')}>Add address</Button>
              </>
            )}
          </>
        }
      />
      <Tabs
        tabs={[
          { id: 'prefixes', label: 'Prefixes' },
          { id: 'addresses', label: 'Addresses' },
          { id: 'warnings', label: 'Warnings' },
          { id: 'spaces', label: 'Spaces' },
        ]}
        value={tab}
        onChange={(t) => setParams(t === 'prefixes' ? {} : { tab: t }, { replace: true })}
      />
      <div className="tab-panel">
        {tab === 'prefixes' && <PrefixTree />}
        {tab === 'addresses' && <AddressList />}
        {tab === 'warnings' && <WarningList />}
        {tab === 'spaces' && <SpaceList />}
      </div>
      {modal === 'prefix' && <PrefixForm projectId={project.id} onClose={() => setModal(null)} onSaved={(p) => nav(link.prefix(project.id, p.id))} />}
      {modal === 'address' && <AddressForm projectId={project.id} onClose={() => setModal(null)} onSaved={(a) => nav(link.address(project.id, a.id))} />}
    </div>
  );
}

export function Utilization({ value }: { value?: number }) {
  if (value == null) return <span className="muted">—</span>;
  const tone = value >= 90 ? 'danger' : value >= 75 ? 'warn' : 'ok';
  return (
    <span className="util" title={`${value}% used`}>
      <span className={`util-bar util-${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
      <span className="util-text">{value}%</span>
    </span>
  );
}

function PrefixTree() {
  const { project } = useProject();
  const nav = useNavigate();
  const spaces = useSpaces(project.id);
  const vlans = useVlans(project.id);
  const [space, setSpace] = useState('');
  const list = useLoad(() => api.get<{ prefixes: Prefix[] }>(`/api/projects/${project.id}/prefixes${qs({ space_id: space })}`).then((r) => r.prefixes), [project.id, space]);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Spinner />;
  const vlan = (id: number | null) => vlans.data?.find((v) => v.id === id);
  const multi = (spaces.data?.length ?? 0) > 1;
  return (
    <div className="stack">
      {multi && (
        <div className="filters">
          <SelectField label="Space" value={space} onChange={(e) => setSpace(e.target.value)} options={[{ value: '', label: 'All spaces' }, ...(spaces.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))]} />
        </div>
      )}
      {list.data.length === 0 ? (
        <Empty title="No prefixes yet">Add the networks you use, e.g. 10.20.30.0/24; smaller ones nest under bigger ones by themselves.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Prefix</th>
                <th>Description</th>
                <th>Role</th>
                <th>VLAN</th>
                <th>Status</th>
                <th>Used</th>
                {multi && <th>Space</th>}
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => nav(link.prefix(project.id, p.id))} data-cidr={p.cidr}>
                  <td style={{ paddingLeft: `${0.75 + (p.depth ?? 0) * 1.25}rem` }}>
                    <Link to={link.prefix(project.id, p.id)} className="mono" onClick={(e) => e.stopPropagation()}>{p.cidr}</Link>
                  </td>
                  <td>{p.description}</td>
                  <td>{p.role}</td>
                  <td>{vlan(p.vlan_id) ? <span className="mono">{vlan(p.vlan_id)!.vid}</span> : null} {vlan(p.vlan_id)?.name}</td>
                  <td>{p.status !== 'active' ? <Badge tone={p.status === 'planned' ? 'info' : 'neutral'}>{p.status}</Badge> : <Badge tone="ok">active</Badge>}</td>
                  <td><Utilization value={p.utilization} /></td>
                  {multi && <td>{spaces.data?.find((s) => s.id === p.space_id)?.name}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddressList() {
  const { project } = useProject();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<IpAddress[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (after?: number) => {
    try {
      const r = await api.get<{ addresses: IpAddress[]; next_after_id: number | null }>(
        `/api/projects/${project.id}/addresses${qs({ q, status, limit: 500, after_id: after })}`,
      );
      setRows((old) => (after ? [...(old ?? []), ...r.addresses] : r.addresses));
      setNext(r.next_after_id);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    const t = setTimeout(() => load(), 250);
    return () => clearTimeout(t);
  }, [q, status, project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack">
      <div className="filters">
        <TextField label="Search" placeholder="Address, DNS name, MAC…" value={q} onChange={(e) => setQ(e.target.value)} />
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Any status' }, ...['reserved', 'assigned', 'deprecated'].map((s) => ({ value: s, label: s }))]} />
      </div>
      <ErrorBox error={error} />
      {!rows ? (
        <Spinner />
      ) : (
        <>
          <AddressTable rows={rows} projectId={project.id} onOpen={(a) => nav(link.address(project.id, a.id))} />
          {next && <Button onClick={() => load(next)}>Load more</Button>}
        </>
      )}
    </div>
  );
}

export function AddressTable({ rows, projectId, onOpen }: { rows: IpAddress[]; projectId: number; onOpen: (a: IpAddress) => void }) {
  return (
    <Table
      rows={rows}
      rowKey={(a) => a.id}
      onRowClick={onOpen}
      empty="No addresses"
      columns={[
        { key: 'address', label: 'Address', render: (a) => <Link to={link.address(projectId, a.id)} className="mono" onClick={(e) => e.stopPropagation()}>{a.address}</Link> },
        { key: 'dns', label: 'DNS name', render: (a) => a.dns_name, sort: (a) => a.dns_name ?? '' },
        {
          key: 'device',
          label: 'Device',
          render: (a) =>
            a.device_id ? (
              <Link to={a.port_id ? link.port(projectId, a.port_id) : link.device(projectId, a.device_id)} onClick={(e) => e.stopPropagation()}>
                {(a.port_path ?? a.device_path ?? '').split('/').slice(-2).join(' ')}
              </Link>
            ) : (
              <span className="muted">spare</span>
            ),
          sort: (a) => a.device_path ?? '',
        },
        { key: 'mac', label: 'MAC', render: (a) => a.mac && <span className="mono small">{a.mac}</span> },
        { key: 'role', label: 'Role', render: (a) => a.role, sort: (a) => a.role },
        { key: 'status', label: 'Status', render: (a) => <Badge tone={a.status === 'assigned' ? 'ok' : a.status === 'reserved' ? 'info' : 'neutral'}>{a.status}</Badge>, sort: (a) => a.status },
        { key: 'src', label: 'Source', render: (a) => <span className="small">{a.source}{a.dhcp_reservation ? ' · reservation' : ''}</span> },
      ]}
    />
  );
}

function WarningList() {
  const { project } = useProject();
  const list = useLoad(() => api.get<{ warnings: IpamWarning[] }>(`/api/projects/${project.id}/ipam/warnings`).then((r) => r.warnings), [project.id]);
  if (list.error) return <ErrorBox error={list.error} onRetry={list.reload} />;
  if (!list.data) return <Spinner />;
  if (list.data.length === 0) return <Empty title="No warnings">Addresses sit inside prefixes, MACs are unique and no static address is inside a DHCP pool.</Empty>;
  const to = (w: IpamWarning) => (w.resource_type === 'ip_address' ? link.address(project.id, w.resource_id) : w.resource_type === 'prefix' ? link.prefix(project.id, w.resource_id) : null);
  return (
    <ul className="list warning-list">
      {list.data.map((w, i) => (
        <li key={i} className="row">
          <Badge tone="warn">{w.kind.replace(/_/g, ' ')}</Badge>
          {to(w) ? <Link to={to(w)!}>{w.message}</Link> : <span>{w.message}</span>}
        </li>
      ))}
    </ul>
  );
}

function SpaceList() {
  const { project, canWrite } = useProject();
  const spaces = useSpaces(project.id);
  const [modal, setModal] = useState<Space | 'new' | null>(null);
  if (spaces.error) return <ErrorBox error={spaces.error} onRetry={spaces.reload} />;
  if (!spaces.data) return <Spinner />;
  return (
    <div className="stack">
      {canWrite && <Button icon={<Plus size={15} />} onClick={() => setModal('new')}>Add space</Button>}
      <Table
        rows={spaces.data}
        rowKey={(s) => s.id}
        onRowClick={canWrite ? (s) => !s.is_default && setModal(s) : undefined}
        columns={[
          { key: 'name', label: 'Name', render: (s) => <>{s.name} {s.is_default && <Badge>default</Badge>}</> },
          { key: 'description', label: 'Description', render: (s) => s.description },
          { key: 'prefixes', label: 'Prefixes', render: (s) => s.prefix_count, className: 'num' },
          { key: 'addresses', label: 'Addresses', render: (s) => s.address_count, className: 'num' },
        ]}
      />
      {modal && <SpaceForm projectId={project.id} existing={modal === 'new' ? undefined : modal} onClose={() => setModal(null)} onSaved={spaces.reload} />}
    </div>
  );
}
