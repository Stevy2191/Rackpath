// One prefix: details, child prefixes, ranges, the IPv4 grid and its
// addresses; the next free address in one click.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { IpAddress, IpRange, PrefixDetail, PrefixGrid } from '../../types';
import { Badge, Button, Card, Empty, ErrorBox, FormModal, PageHeader, Spinner, Table, fmtTime, useLoad, useToast } from '../../ui';
import { KeyValues } from '../places/common';
import { AddressForm, PrefixForm, RANGE_KINDS, RangeForm, useVlans } from './Forms';
import { AddressTable, Utilization, usageDetail } from './Ipam';

type Modal = { t: 'edit' } | { t: 'delete' } | { t: 'range'; r?: IpRange } | { t: 'address'; address?: string; next?: boolean } | { t: 'child' };

export function PrefixPage() {
  const { project } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const prefix = useLoad(() => api.get<PrefixDetail>(`/api/prefixes/${id}`), [id]);
  const vlans = useVlans(project.id);
  const [modal, setModal] = useState<Modal | null>(null);
  const [version, setVersion] = useState(0);
  if (prefix.error) return <ErrorBox error={prefix.error} onRetry={prefix.reload} />;
  if (!prefix.data) return <Spinner />;
  const p = prefix.data;
  const reload = () => {
    setVersion((v) => v + 1);
    prefix.reload();
  };
  const vlan = vlans.data?.find((v) => v.id === p.vlan_id);
  const gridable = p.family === 4 && p.prefix_len >= 22;
  const usable = Number(p.size) - (p.family === 4 && p.prefix_len < 31 ? 2 : 0);
  const close = () => setModal(null);
  return (
    <div>
      <nav className="crumbs">
        <Link to={link.ipam(project.id)}>IP addresses</Link>
        {p.parent && (
          <>
            <span aria-hidden> / </span>
            <Link to={link.prefix(project.id, p.parent.id)}>{p.parent.cidr}</Link>
          </>
        )}
      </nav>
      <PageHeader
        title={<span className="mono">{p.cidr}</span>}
        subtitle={[p.description, p.role, vlan ? `VLAN ${vlan.vid} ${vlan.name}` : null].filter(Boolean).join(' · ')}
        actions={
          p.can_edit && (
            <>
              <Button variant="primary" icon={<Wand2 size={15} />} onClick={() => setModal({ t: 'address', next: true })}>Next free address</Button>
              <Button icon={<Pencil size={15} />} onClick={() => setModal({ t: 'edit' })}>Edit</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal({ t: 'delete' })}>Delete</Button>
            </>
          )
        }
      />
      {p.missing_from_source_at && <div className="error-box" role="status">Not seen by {p.source} since {fmtTime(p.missing_from_source_at)}.</div>}
      <div className="grid-2">
        <Card title="Details">
          <KeyValues
            rows={[
              ['Status', <Badge tone={p.status === 'active' ? 'ok' : p.status === 'planned' ? 'info' : 'neutral'}>{p.status}</Badge>],
              ['Size', `${p.size} addresses${p.family === 4 ? ` (${usable} usable)` : ''}`],
              ['Used', p.utilization != null ? <Utilization value={p.utilization} detail={usageDetail(p)} /> : null],
              ['In use', usageDetail(p)],
              ['Gateway', p.gateway && <span className="mono">{p.gateway}</span>],
              ['DNS servers', p.dns_servers && <span className="mono">{p.dns_servers}</span>],
              ['Domain', p.domain_name],
              ['Source', p.source !== 'manual' ? p.source : null],
              ['Notes', p.notes && <span className="pre">{p.notes}</span>],
            ]}
          />
        </Card>
        <Card title="Ranges" actions={p.can_edit && <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal({ t: 'range' })}>Add range</Button>}>
          {p.ranges.length === 0 ? (
            <p className="small muted">No DHCP pools or reserved ranges.</p>
          ) : (
            <ul className="list">
              {p.ranges.map((r) => (
                <li key={r.id} className="row">
                  <span className={`swatch range-${r.kind}`} />
                  <span className="mono">{r.start_text} – {r.end_text}</span>
                  <span className="small muted">{RANGE_KINDS.find((k) => k.value === r.kind)?.label}{r.description ? ` · ${r.description}` : ''}</span>
                  <span className="grow" />
                  {p.can_edit && <Button variant="ghost" aria-label={`Edit range ${r.start_text}`} icon={<Pencil size={14} />} onClick={() => setModal({ t: 'range', r })} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {p.children.length > 0 && (
        <Card title="Smaller prefixes inside" className="mt">
          <Table
            rows={p.children}
            rowKey={(c) => c.id}
            onRowClick={(c) => nav(link.prefix(project.id, c.id))}
            columns={[
              { key: 'cidr', label: 'Prefix', render: (c) => <Link to={link.prefix(project.id, c.id)} className="mono">{c.cidr}</Link> },
              { key: 'desc', label: 'Description', render: (c) => c.description },
              { key: 'role', label: 'Role', render: (c) => c.role },
              { key: 'status', label: 'Status', render: (c) => c.status },
            ]}
          />
        </Card>
      )}
      {gridable && (
        <Card title="Address map" className="mt">
          <AddressGrid
            prefixId={p.id}
            version={version}
            onCell={(off, addr) => {
              if (addr) nav(link.address(project.id, addr.id));
              else if (p.can_edit) setModal({ t: 'address', address: offsetToIp(p.cidr, off) });
            }}
          />
        </Card>
      )}
      <Card title={`Addresses${p.addresses_truncated ? ' (first ones)' : ''}`} className="mt" actions={p.can_edit && <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal({ t: 'address' })}>Add address</Button>}>
        {p.addresses.length === 0 ? <Empty title="No addresses documented here" /> : <AddressTable rows={p.addresses} projectId={project.id} onOpen={(a: IpAddress) => nav(link.address(project.id, a.id))} />}
      </Card>
      {modal?.t === 'edit' && <PrefixForm projectId={project.id} existing={p} onClose={close} onSaved={reload} />}
      {modal?.t === 'range' && <RangeForm prefixId={p.id} existing={modal.r} onClose={close} onSaved={reload} />}
      {modal?.t === 'address' && (
        <AddressForm
          projectId={project.id}
          prefixId={p.id}
          address={modal.address}
          onClose={close}
          onSaved={(a) => {
            if (modal.next) toast.ok(`Documented ${a.address}`);
            reload();
          }}
        />
      )}
      {modal?.t === 'delete' && (
        <FormModal
          title={`Delete ${p.cidr}`}
          submitLabel="Delete"
          danger
          onClose={close}
          onSubmit={async () => {
            await api.del(`/api/prefixes/${p.id}`);
            toast.ok(`Deleted ${p.cidr}`);
            nav(p.parent ? link.prefix(project.id, p.parent.id) : link.ipam(project.id));
          }}
        >
          <p>The prefix and its ranges are deleted. Its addresses stay documented and move to the next bigger prefix, if any.</p>
        </FormModal>
      )}
    </div>
  );
}

/** a.b.c.d/len + offset → address text (IPv4). */
export function offsetToIp(cidr: string, off: number): string {
  const [a, b, c, d] = cidr.split('/')[0].split('.').map(Number);
  const n = (((a << 24) >>> 0) + (b << 16) + (c << 8) + d + off) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function AddressGrid({ prefixId, version, onCell }: { prefixId: number; version: number; onCell: (offset: number, a?: IpAddress) => void }) {
  const grid = useLoad(() => api.get<PrefixGrid>(`/api/prefixes/${prefixId}/grid`), [prefixId, version]);
  const [showLeases, setShowLeases] = useState(true);
  if (grid.error) return <ErrorBox error={grid.error} />;
  if (!grid.data) return <Spinner />;
  const g = grid.data;
  const addrs = new Map(g.addresses.map((a) => [a.offset, a]));
  const leases = new Map(g.leases.map((l) => [l.offset, l]));
  const rangeAt = (o: number) => g.ranges.find((r) => o >= r.from && o <= r.to);
  const cells = [];
  for (let o = 0; o < g.size; o++) {
    const a = addrs.get(o);
    const l = showLeases ? leases.get(o) : undefined;
    const r = rangeAt(o);
    const special = o === g.network ? 'network' : o === g.broadcast ? 'broadcast' : o === g.gateway ? 'gateway' : null;
    const cls = ['cell', special ?? '', a ? `addr addr-${a.status}` : '', r ? `range-${r.kind}` : '', l && !a ? 'lease' : ''].filter(Boolean).join(' ');
    const ip = offsetToIp(g.cidr, o);
    const title = [ip, special, a ? `${a.dns_name ?? a.device_path?.split('/').pop() ?? a.status}` : null, r ? `${r.kind.replace('_', ' ')}${r.description ? `: ${r.description}` : ''}` : null, l && !a ? `lease: ${l.hostname ?? l.mac ?? ''}` : null]
      .filter(Boolean)
      .join(' · ');
    cells.push(
      <button
        key={o}
        type="button"
        className={cls}
        title={title}
        aria-label={title}
        disabled={special === 'network' || special === 'broadcast'}
        onClick={() => onCell(o, a)}
      >
        {o % 256}
      </button>,
    );
  }
  return (
    <div className="stack">
      <div className="row small legend">
        <span><i className="cell addr addr-assigned" /> assigned</span>
        <span><i className="cell addr addr-reserved" /> reserved</span>
        <span><i className="cell range-dhcp_pool" /> DHCP pool</span>
        <span><i className="cell range-reserved" /> reserved range</span>
        <span><i className="cell gateway" /> gateway</span>
        {g.leases.length > 0 && (
          <label className="row">
            <input type="checkbox" checked={showLeases} onChange={(e) => setShowLeases(e.target.checked)} /> <i className="cell lease" /> DHCP leases ({g.leases.length})
          </label>
        )}
      </div>
      <div className="ip-grid">{cells}</div>
    </div>
  );
}
