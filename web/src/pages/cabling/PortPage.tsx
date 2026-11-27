// One port: its details, cables, VLANs and the chain through it.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { ListedPort } from '../../types';
import { Badge, Button, Card, ErrorBox, PageHeader, Spinner, useLoad } from '../../ui';
import { Crumbs, KeyValues } from '../places/common';
import { CableEdit, ConnectForm, freeSides } from './Connect';
import { speedText } from './media';
import { PortForm } from './PortForm';
import { PortVlansForm } from '../network/Vlans';
import { stateText, stateTone, TraceView } from './Trace';

export function PortPage() {
  const { project } = useProject();
  const { id } = useParams();
  const port = useLoad(() => api.get<ListedPort>(`/api/ports/${id}`), [id]);
  const [modal, setModal] = useState<{ t: 'edit' } | { t: 'vlans' } | { t: 'connect'; side: 'front' | 'rear' } | { t: 'cable'; id: number } | null>(null);
  const [version, setVersion] = useState(0);
  if (port.error) return <ErrorBox error={port.error} onRetry={port.reload} />;
  if (!port.data) return <Spinner />;
  const p = port.data;
  const reload = () => {
    setVersion((v) => v + 1);
    port.reload();
  };
  const segments = p.path.split('/');
  const sides: ('front' | 'rear')[] = p.role === 'passive' ? ['front', 'rear'] : ['front'];
  return (
    <div>
      <Crumbs path={p.path} links={segments.slice(1).map((_, i) => (i === segments.length - 3 ? link.device(project.id, p.device_id) : undefined))} />
      <PageHeader
        title={<>Port <span className="mono">{p.code}</span>{p.interface_name && <span className="title-name"> {p.interface_name}</span>}</>}
        subtitle={<><Link to={link.device(project.id, p.device_id)}>{segments.slice(1, -1).join(' / ')}</Link> · <Badge tone={stateTone(p.chain_state)}>{stateText(p.chain_state)}</Badge></>}
        actions={p.can_edit && <Button icon={<Pencil size={15} />} onClick={() => setModal({ t: 'edit' })}>Edit</Button>}
      />
      <div className="grid-2">
        <Card title="Port">
          <KeyValues
            rows={[
              ['Role', p.role === 'passive' ? `Passive${p.requires_permanent ? '' : ' (coupler)'}` : 'Active'],
              ['Connector', p.connector],
              ['Module', p.transceiver],
              ['Speed', speedText(p.effective_speed)],
              ['PoE', p.poe],
              ['MAC', p.mac && <span className="mono">{p.mac}</span>],
              [
                'VLANs',
                <span className="row">
                  {p.vlans.map((v) => `${v.vid} ${v.name}${v.mode === 'tagged' ? ' (tagged)' : ''}`).join(', ') || <span className="muted">None</span>}
                  {p.can_edit && <Button variant="ghost" onClick={() => setModal({ t: 'vlans' })}>Set VLANs</Button>}
                </span>,
              ],
              ['Description', p.description],
              ['Notes', p.notes && <span className="pre">{p.notes}</span>],
            ]}
          />
        </Card>
        <Card title="Cables">
          <div className="stack">
            {sides.map((s) => {
              const c = p[s];
              return (
                <div key={s} className="row">
                  {p.role === 'passive' && <strong className="small" style={{ width: '3.5rem' }}>{s === 'front' ? 'Front' : 'Rear'}</strong>}
                  {c ? (
                    <>
                      <span className="swatch" style={{ background: c.color ?? 'var(--color-border-strong)' }} />
                      <Link to={link.port(project.id, c.far.port_id)} className="mono">{c.far.path.split('/').slice(1).join(' / ')}</Link>
                      {c.far.device_name && <span className="muted"> · {c.far.device_name}</span>}
                      <span className="small muted">{[c.kind, c.cable_type, c.length_m != null ? `${c.length_m} m` : null, c.label].filter(Boolean).join(' · ')}</span>
                      {p.can_edit && <Button variant="ghost" onClick={() => setModal({ t: 'cable', id: c.connection_id })}>Change</Button>}
                    </>
                  ) : (
                    <>
                      <span className="muted">Nothing connected</span>
                      {p.can_edit && freeSides(p).includes(s) && <Button variant="ghost" onClick={() => setModal({ t: 'connect', side: s })}>Connect</Button>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      <Card title="Chain" className="mt">
        <TraceView portId={p.id} projectId={project.id} canEdit={p.can_edit} version={version} onChanged={reload} />
      </Card>
      {modal?.t === 'vlans' && <PortVlansForm projectId={project.id} portId={p.id} current={p.vlans} onClose={() => setModal(null)} onSaved={reload} />}
      {modal?.t === 'edit' && <PortForm deviceId={p.device_id} existing={p} onClose={() => setModal(null)} onSaved={reload} />}
      {modal?.t === 'connect' && <ConnectForm projectId={project.id} from={p} side={modal.side} onClose={() => setModal(null)} onSaved={reload} />}
      {modal?.t === 'cable' && <CableEdit id={modal.id} onClose={() => setModal(null)} onSaved={reload} />}
    </div>
  );
}
