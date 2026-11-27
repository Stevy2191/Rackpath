import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Building2, MoveRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { Floor, Location } from '../../types';
import { Button, Card, Empty, ErrorBox, FormModal, PageHeader, Spinner, Table, TextArea, TextField, useLoad, useToast } from '../../ui';
import { Crumbs, DeleteModal, KeyValues, useForm } from './common';
import { MoveLocation } from './Move';

type LocationRow = Location & { counts: NonNullable<Location['counts']> };

export function LocationsPage() {
  const { project, canWrite } = useProject();
  const nav = useNavigate();
  const list = useLoad(() => api.get<LocationRow[]>(`/api/projects/${project.id}/locations`), [project.id]);
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <PageHeader
        title="Locations"
        subtitle="Sites, with their floors, rooms and racks"
        actions={canWrite && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>Add location</Button>}
      />
      <ErrorBox error={list.error} onRetry={list.reload} />
      {list.loading && !list.data && <Spinner />}
      {list.data && (
        <Table
          rows={list.data}
          rowKey={(l) => l.id}
          onRowClick={(l) => nav(link.location(project.id, l.id))}
          empty="No locations yet"
          columns={[
            { key: 'code', label: 'Code', render: (l) => <Link to={link.location(project.id, l.id)} className="mono">{l.code}</Link>, sort: (l) => l.code },
            { key: 'name', label: 'Name', render: (l) => l.name, sort: (l) => l.name ?? '' },
            { key: 'city', label: 'City', render: (l) => l.address_city, sort: (l) => l.address_city ?? '' },
            { key: 'floors', label: 'Floors', render: (l) => l.counts.floors, sort: (l) => l.counts.floors, className: 'num' },
            { key: 'racks', label: 'Racks', render: (l) => l.counts.racks, sort: (l) => l.counts.racks, className: 'num' },
            { key: 'devices', label: 'Devices', render: (l) => l.counts.devices, sort: (l) => l.counts.devices, className: 'num' },
          ]}
        />
      )}
      {adding && (
        <LocationForm
          projectId={project.id}
          onClose={() => setAdding(false)}
          onSaved={(l) => nav(link.location(project.id, l.id))}
        />
      )}
    </div>
  );
}

const LOCATION_FIELDS = [
  'code', 'name', 'address_street', 'address_city', 'address_state', 'address_postcode', 'address_country',
  'contact_name', 'contact_phone', 'contact_email',
  'isp_primary_name', 'isp_primary_circuit', 'isp_primary_contact',
  'isp_secondary_name', 'isp_secondary_circuit', 'isp_secondary_contact', 'notes',
] as const;

function LocationForm({ projectId, existing, onClose, onSaved }: { projectId: number; existing?: Location; onClose: () => void; onSaved: (l: Location) => void }) {
  const init = Object.fromEntries(LOCATION_FIELDS.map((k) => [k, (existing?.[k] as string | null) ?? ''])) as Record<(typeof LOCATION_FIELDS)[number], string>;
  const f = useForm(init);
  return (
    <FormModal
      title={existing ? `Edit ${existing.code}` : 'Add location'}
      wide
      onClose={onClose}
      onSubmit={async () => {
        const saved = existing
          ? await api.patch<Location>(`/api/locations/${existing.id}`, f.values)
          : await api.post<Location>(`/api/projects/${projectId}/locations`, f.values);
        onSaved(saved);
      }}
    >
      <div className="grid-2">
        <TextField label="Code" required maxLength={16} hint="Short and unique, e.g. HQ" {...f.bind('code')} />
        <TextField label="Name" {...f.bind('name')} />
      </div>
      <h4 className="form-section">Address</h4>
      <TextField label="Street" {...f.bind('address_street')} />
      <div className="grid-2">
        <TextField label="City" {...f.bind('address_city')} />
        <TextField label="State / region" {...f.bind('address_state')} />
        <TextField label="Postcode" {...f.bind('address_postcode')} />
        <TextField label="Country" {...f.bind('address_country')} />
      </div>
      <h4 className="form-section">Site contact</h4>
      <div className="grid-2">
        <TextField label="Name" {...f.bind('contact_name')} />
        <TextField label="Phone" {...f.bind('contact_phone')} />
        <TextField label="Email" type="email" {...f.bind('contact_email')} />
      </div>
      <h4 className="form-section">Internet</h4>
      <div className="grid-3">
        <TextField label="Primary ISP" {...f.bind('isp_primary_name')} />
        <TextField label="Circuit ID" {...f.bind('isp_primary_circuit')} />
        <TextField label="Support contact" {...f.bind('isp_primary_contact')} />
        <TextField label="Secondary ISP" {...f.bind('isp_secondary_name')} />
        <TextField label="Circuit ID" {...f.bind('isp_secondary_circuit')} />
        <TextField label="Support contact" {...f.bind('isp_secondary_contact')} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}

export function LocationPage() {
  const { project } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const loc = useLoad(() => api.get<Location>(`/api/locations/${id}`), [id]);
  const [modal, setModal] = useState<'edit' | 'delete' | 'floor' | 'move' | null>(null);
  if (loc.error) return <ErrorBox error={loc.error} onRetry={loc.reload} />;
  if (!loc.data) return <Spinner />;
  const l = loc.data;
  const devices = l.floors?.reduce((n, f) => n + f.devices, 0) ?? 0;
  const addr = [l.address_street, l.address_city, l.address_state, l.address_postcode, l.address_country].filter(Boolean).join(', ');
  return (
    <div>
      <Crumbs path={l.path} links={[]} />
      <PageHeader
        title={<><span className="mono">{l.code}</span>{l.name && <span className="title-name"> {l.name}</span>}</>}
        actions={
          l.can_edit && (
            <>
              <Button icon={<Pencil size={15} />} onClick={() => setModal('edit')}>Edit</Button>
              <Button icon={<MoveRight size={15} />} onClick={() => setModal('move')}>Move</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal('delete')}>Delete</Button>
            </>
          )
        }
      />
      <div className="grid-2">
        <Card
          title="Floors"
          actions={l.can_edit && <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal('floor')}>Add floor</Button>}
        >
          {l.floors && l.floors.length > 0 ? (
            <ul className="list">
              {l.floors.map((f) => (
                <li key={f.id}>
                  <Link to={link.floor(project.id, f.id)} className="row">
                    <Building2 size={15} />
                    <strong className="mono">{f.code}</strong>
                    <span>{f.name}</span>
                    <span className="grow" />
                    <span className="small muted">
                      level {f.level} · {f.rooms} room(s) · {f.racks} rack(s) · {f.devices} device(s)
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No floors yet" />
          )}
        </Card>
        <Card title="Details">
          <KeyValues
            rows={[
              ['Address', addr],
              ['Contact', [l.contact_name, l.contact_phone, l.contact_email].filter(Boolean).join(' · ')],
              ['Primary ISP', [l.isp_primary_name, l.isp_primary_circuit, l.isp_primary_contact].filter(Boolean).join(' · ')],
              ['Secondary ISP', [l.isp_secondary_name, l.isp_secondary_circuit, l.isp_secondary_contact].filter(Boolean).join(' · ')],
              ['Notes', l.notes && <span className="pre">{l.notes}</span>],
            ]}
          />
        </Card>
      </div>
      {modal === 'move' && (
        <MoveLocation
          projectId={project.id}
          locationId={l.id}
          onClose={() => setModal(null)}
          onMoved={(r) => {
            toast.ok(`Moved to ${r.to.split('/')[0]}`);
            nav(link.location(r.project_id, l.id));
          }}
        />
      )}
      {modal === 'edit' && <LocationForm projectId={project.id} existing={l} onClose={() => setModal(null)} onSaved={() => loc.reload()} />}
      {modal === 'floor' && (
        <FloorForm
          locationId={l.id}
          onClose={() => setModal(null)}
          onSaved={(f) => nav(link.floor(project.id, f.id))}
        />
      )}
      {modal === 'delete' && (
        <DeleteModal
          kind="location"
          code={l.code}
          url={`/api/locations/${l.id}`}
          devices={devices}
          onClose={() => setModal(null)}
          onDone={() => {
            toast.ok(`Deleted ${l.code}`);
            nav(link.locations(project.id));
          }}
        />
      )}
    </div>
  );
}

export function FloorForm({ locationId, existing, onClose, onSaved }: { locationId: number; existing?: Floor; onClose: () => void; onSaved: (f: Floor) => void }) {
  const f = useForm({
    code: existing?.code ?? '',
    name: existing?.name ?? '',
    level: String(existing?.level ?? 0),
    scale_px_per_m: existing?.scale_px_per_m != null ? String(existing.scale_px_per_m) : '',
    notes: existing?.notes ?? '',
  });
  return (
    <FormModal
      title={existing ? `Edit floor ${existing.code}` : 'Add floor'}
      onClose={onClose}
      onSubmit={async () => {
        const body = {
          ...f.values,
          level: Number(f.values.level) || 0,
          scale_px_per_m: f.values.scale_px_per_m === '' ? undefined : Number(f.values.scale_px_per_m),
        };
        const saved = existing
          ? await api.patch<Floor>(`/api/floors/${existing.id}`, body)
          : await api.post<Floor>(`/api/locations/${locationId}/floors`, body);
        onSaved(saved);
      }}
    >
      <div className="grid-2">
        <TextField label="Code" required maxLength={16} hint="e.g. F1 or GF" {...f.bind('code')} />
        <TextField label="Name" {...f.bind('name')} />
        <TextField label="Level" type="number" step={1} hint="0 is ground, negative is below" {...f.bind('level')} />
        <TextField label="Plan scale (pixels per metre)" type="number" min={0} step="any" hint="Draws racks to size on the plan" {...f.bind('scale_px_per_m')} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}
