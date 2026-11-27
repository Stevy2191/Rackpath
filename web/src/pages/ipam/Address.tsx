import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { IpAddress } from '../../types';
import { Badge, Button, Card, ErrorBox, FormModal, PageHeader, Spinner, fmtTime, useLoad, useToast } from '../../ui';
import { KeyValues } from '../places/common';
import { AddressForm } from './Forms';

type Detail = IpAddress & { prefix?: { id: number; cidr: string } | null; prefix_id?: number | null; can_edit?: boolean };

export function AddressPage() {
  const { project } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const addr = useLoad(() => api.get<Detail>(`/api/addresses/${id}`), [id]);
  const [modal, setModal] = useState<'edit' | 'delete' | null>(null);
  if (addr.error) return <ErrorBox error={addr.error} onRetry={addr.reload} />;
  if (!addr.data) return <Spinner />;
  const a = addr.data;
  const prefix = a.prefix ?? null;
  return (
    <div>
      <nav className="crumbs">
        <Link to={link.ipam(project.id)}>IP addresses</Link>
        {prefix && (
          <>
            <span aria-hidden> / </span>
            <Link to={link.prefix(project.id, prefix.id)}>{prefix.cidr}</Link>
          </>
        )}
      </nav>
      <PageHeader
        title={<span className="mono">{a.address}{a.prefix_len != null ? `/${a.prefix_len}` : ''}</span>}
        subtitle={<>{a.dns_name ?? 'no DNS name'} · <Badge tone={a.status === 'assigned' ? 'ok' : 'info'}>{a.status}</Badge></>}
        actions={
          a.can_edit && (
            <>
              <Button icon={<Pencil size={15} />} onClick={() => setModal('edit')}>Edit</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal('delete')}>Delete</Button>
            </>
          )
        }
      />
      {a.missing_from_source_at && <div className="error-box" role="status">Not seen by {a.source} since {fmtTime(a.missing_from_source_at)}.</div>}
      <Card title="Details">
        <KeyValues
          rows={[
            ['Device', a.device_id ? <Link to={link.device(project.id, a.device_id)}>{a.device_path?.split('/').slice(1).join(' / ')}{a.device_name ? ` · ${a.device_name}` : ''}</Link> : <span className="muted">Not linked to a device</span>],
            ['Port', a.port_id && <Link to={link.port(project.id, a.port_id)} className="mono">{a.port_path?.split('/').pop()}</Link>],
            ['Role', a.role],
            ['MAC', a.mac && <span className="mono">{a.mac}</span>],
            ['DNS aliases', a.dns_aliases.join(', ')],
            ['DHCP reservation', a.dhcp_reservation ? 'Yes' : null],
            ['Description', a.description],
            ['Source', a.source !== 'manual' ? a.source : null],
            ['Notes', a.notes && <span className="pre">{a.notes}</span>],
          ]}
        />
      </Card>
      {modal === 'edit' && <AddressForm projectId={project.id} existing={a} onClose={() => setModal(null)} onSaved={addr.reload} />}
      {modal === 'delete' && (
        <FormModal
          title={`Delete ${a.address}`}
          submitLabel="Delete"
          danger
          onClose={() => setModal(null)}
          onSubmit={async () => {
            await api.del(`/api/addresses/${a.id}`);
            toast.ok(`Deleted ${a.address}`);
            nav(prefix ? link.prefix(project.id, prefix.id) : link.ipam(project.id));
          }}
        >
          <p>The address is no longer documented. The device keeps its other addresses.</p>
        </FormModal>
      )}
    </div>
  );
}
