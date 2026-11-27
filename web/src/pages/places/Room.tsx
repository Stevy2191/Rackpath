import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pencil, Plus, Server, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { Room } from '../../types';
import { Badge, Button, Card, Empty, ErrorBox, FormModal, PageHeader, Spinner, Table, TextArea, TextField, useLoad, useToast } from '../../ui';
import { DeviceForm } from '../devices/DeviceForm';
import { Crumbs, DeleteModal, KeyValues, useForm } from './common';
import { RackForm } from './Rack';
import { ReportButton } from '../Exports';

export function RoomForm({ floorId, existing, onClose, onSaved }: { floorId: number; existing?: Room; onClose: () => void; onSaved: (r: Room) => void }) {
  const f = useForm({
    code: existing?.code ?? '',
    name: existing?.name ?? '',
    color: existing?.color ?? '',
    contact_name: existing?.contact_name ?? '',
    contact_phone: existing?.contact_phone ?? '',
    contact_email: existing?.contact_email ?? '',
    notes: existing?.notes ?? '',
  });
  return (
    <FormModal
      title={existing ? `Edit room ${existing.code}` : 'Add room'}
      onClose={onClose}
      onSubmit={async () => {
        const saved = existing
          ? await api.patch<Room>(`/api/rooms/${existing.id}`, f.values)
          : await api.post<Room>(`/api/floors/${floorId}/rooms`, f.values);
        onSaved(saved);
      }}
    >
      <div className="grid-2">
        <TextField label="Code" required maxLength={16} hint="e.g. SR1 or MDF" {...f.bind('code')} disabled={existing?.is_default} />
        <TextField label="Name" {...f.bind('name')} />
        <TextField label="Colour on the plan" placeholder="#3b82f6" {...f.bind('color')} />
        <TextField label="Contact" {...f.bind('contact_name')} />
        <TextField label="Phone" {...f.bind('contact_phone')} />
        <TextField label="Email" type="email" {...f.bind('contact_email')} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}

export function RoomPage() {
  const { project } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const room = useLoad(() => api.get<Room>(`/api/rooms/${id}`), [id]);
  const [modal, setModal] = useState<'edit' | 'delete' | 'rack' | 'device' | null>(null);
  if (room.error) return <ErrorBox error={room.error} onRetry={room.reload} />;
  if (!room.data) return <Spinner />;
  const r = room.data;
  const racks = r.racks ?? [];
  const devices = r.devices ?? [];
  const total = devices.length + racks.reduce((n, k) => n + k.device_count, 0);
  return (
    <div>
      <Crumbs path={r.path} links={[undefined, link.floor(project.id, r.floor_id)]} />
      <PageHeader
        title={<><span className="mono">{r.code}</span>{r.name && <span className="title-name"> {r.name}</span>} {r.is_default && <Badge>default room</Badge>}</>}
        actions={
          <>
            <ReportButton type="room" id={r.id} />
            {r.can_edit && (
              <>
                <Button icon={<Pencil size={15} />} onClick={() => setModal('edit')}>Edit</Button>
                {!r.is_default && <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal('delete')}>Delete</Button>}
              </>
            )}
          </>
        }
      />
      <div className="grid-2">
        <Card title="Racks" actions={r.can_edit && <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal('rack')}>Add rack</Button>}>
          {racks.length === 0 ? (
            <Empty title="No racks in this room" />
          ) : (
            <ul className="list">
              {racks.map((k) => (
                <li key={k.id}>
                  <Link to={link.rack(project.id, k.id)} className="row">
                    <Server size={15} />
                    <strong className="mono">{k.code}</strong>
                    <span>{k.name}</span>
                    <span className="grow" />
                    <span className="small muted">{k.u_height}U · {k.device_count} device(s)</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Details">
          <KeyValues
            rows={[
              ['Contact', [r.contact_name, r.contact_phone, r.contact_email].filter(Boolean).join(' · ')],
              ['Outline', r.shape ? `${r.shape.points.length} corners` : r.is_default ? 'The whole floor' : 'Not drawn yet'],
              ['Notes', r.notes && <span className="pre">{r.notes}</span>],
            ]}
          />
        </Card>
      </div>
      <Card
        title="Devices in the room (not in a rack)"
        className="mt"
        actions={r.can_edit && <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal('device')}>Add device</Button>}
      >
        <Table
          rows={devices}
          rowKey={(d) => d.id}
          onRowClick={(d) => nav(link.device(project.id, d.id))}
          empty="No floor-standing devices"
          columns={[
            { key: 'code', label: 'Code', render: (d) => <Link to={link.device(project.id, d.id)} className="mono">{d.code}</Link>, sort: (d) => d.code },
            { key: 'name', label: 'Name', render: (d) => d.name, sort: (d) => d.name ?? '' },
            { key: 'type', label: 'Type', render: (d) => d.device_type.label, sort: (d) => d.device_type.label },
            { key: 'model', label: 'Model', render: (d) => [d.manufacturer, d.model].filter(Boolean).join(' ') },
          ]}
        />
      </Card>
      {modal === 'edit' && <RoomForm floorId={r.floor_id} existing={r} onClose={() => setModal(null)} onSaved={room.reload} />}
      {modal === 'rack' && <RackForm rooms={[r]} projectId={project.id} onClose={() => setModal(null)} onSaved={(k) => nav(link.rack(project.id, k.id))} />}
      {modal === 'device' && (
        <DeviceForm projectId={project.id} placement={{ type: 'room', room_id: r.id, x: null, y: null, rotation: null }} onClose={() => setModal(null)} onSaved={room.reload} />
      )}
      {modal === 'delete' && (
        <DeleteModal
          kind="room"
          code={r.code}
          url={`/api/rooms/${r.id}`}
          devices={total}
          onClose={() => setModal(null)}
          onDone={() => {
            toast.ok(`Deleted ${r.code}`);
            nav(link.floor(project.id, r.floor_id));
          }}
        />
      )}
    </div>
  );
}
