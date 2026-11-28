import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowDownToLine, Building2, MoveRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { Floor, Location } from '../../types';
import { Button, Card, Empty, ErrorBox, FormModal, PageHeader, Spinner, Table, TextArea, TextField, useLoad, useToast } from '../../ui';
import { Crumbs, DeleteModal, KeyValues, useForm } from './common';
import { MoveLocation } from './Move';
import { AddRackButton, PlaceInRoom } from './Quick';
import { RackRow } from './RackRow';
import { DeviceForm } from '../devices/DeviceForm';
import { ReportButton } from '../Exports';
import { formatPhone } from '../../phone';

type LocationRow = Location & { counts: NonNullable<Location['counts']> };

/** Locations grouped by site, in the server's order (by site, then code;
 * those without a site last). */
function bySite(rows: LocationRow[]): { site: string | null; rows: LocationRow[] }[] {
  const groups: { site: string | null; rows: LocationRow[] }[] = [];
  for (const l of rows) {
    const last = groups[groups.length - 1];
    if (last && last.site === l.site) last.rows.push(l);
    else groups.push({ site: l.site, rows: [l] });
  }
  return groups;
}

export function LocationsPage() {
  const { project, canWrite } = useProject();
  const nav = useNavigate();
  const list = useLoad(() => api.get<LocationRow[]>(`/api/projects/${project.id}/locations`), [project.id]);
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <PageHeader
        title="Locations"
        subtitle="Each location is a building, with its floors, rooms and racks. Give buildings a site to group them."
        actions={
          canWrite && (
            <>
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>Add location</Button>
              <AddRackButton projectId={project.id} />
            </>
          )
        }
      />
      <ErrorBox error={list.error} onRetry={list.reload} />
      {list.loading && !list.data && <Spinner />}
      {list.data &&
        (() => {
          const groups = bySite(list.data);
          // No sites in use: one plain list, as before.
          const grouped = groups.some((g) => g.site !== null);
          return groups.map((g) => (
            <section key={g.site ?? ''} className={grouped ? 'site-group' : undefined} aria-label={grouped ? g.site ?? 'No site' : undefined}>
              {grouped && <h3 className="site-heading">{g.site ?? 'No site'}</h3>}
              <Table
                rows={g.rows}
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
            </section>
          ));
        })()}
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
  'isp_secondary_name', 'isp_secondary_circuit', 'isp_secondary_contact', 'notes', 'site',
] as const;

export function LocationForm({
  projectId,
  existing,
  intro,
  onClose,
  onSaved,
}: {
  projectId: number;
  existing?: Location;
  /** A line above the form, e.g. why a location is needed now. */
  intro?: string;
  onClose: () => void;
  /** Return false to keep the dialog open (a next step follows). */
  onSaved: (l: Location) => unknown;
}) {
  const init = Object.fromEntries(LOCATION_FIELDS.map((k) => [k, (existing?.[k] as string | null) ?? ''])) as Record<(typeof LOCATION_FIELDS)[number], string>;
  const f = useForm(init);
  // Sites already used in the project, offered as suggestions so a campus's
  // buildings end up under one spelling.
  const all = useLoad(() => api.get<Location[]>(`/api/projects/${projectId}/locations`), [projectId]);
  const sites = [...new Set((all.data ?? []).map((l) => l.site).filter((s): s is string => !!s))];
  return (
    <FormModal
      title={existing ? `Edit ${existing.code}` : 'Add location'}
      wide
      onClose={onClose}
      onSubmit={async () => {
        const saved = existing
          ? await api.patch<Location>(`/api/locations/${existing.id}`, f.values)
          : await api.post<Location>(`/api/projects/${projectId}/locations`, f.values);
        if (onSaved(saved) === false) return false;
      }}
    >
      {intro && <p className="small muted">{intro}</p>}
      <div className="grid-2">
        <TextField label="Code" required maxLength={16} hint="Short and unique, e.g. HQ" {...f.bind('code')} />
        <TextField label="Name" {...f.bind('name')} />
      </div>
      <TextField
        label="Site"
        maxLength={100}
        list="location-sites"
        hint="Optional. Buildings with the same site are grouped together, e.g. the buildings of one campus."
        {...f.bind('site')}
      />
      <datalist id="location-sites">
        {sites.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
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
        <TextField
          label="Phone"
          type="tel"
          placeholder="(979) 203-4748"
          {...f.bind('contact_phone')}
          onBlur={() => f.set('contact_phone', formatPhone(f.values.contact_phone))}
        />
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
  // One floor and no rooms drawn: skip the floor and room pages and show the
  // racks and devices here. Floors and rooms show up once they're used.
  const simple = l.floors?.length === 1 && l.floors[0].rooms <= 1;
  return (
    <div>
      <Crumbs path={l.path} links={[]} />
      <PageHeader
        title={<><span className="mono">{l.code}</span>{l.name && <span className="title-name"> {l.name}</span>}</>}
        actions={
          <>
            <ReportButton type="location" id={l.id} />
            {l.can_edit && (
              <>
                <Button icon={<Pencil size={15} />} onClick={() => setModal('edit')}>Edit</Button>
                <Button icon={<MoveRight size={15} />} onClick={() => setModal('move')}>Move</Button>
                <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal('delete')}>Delete</Button>
              </>
            )}
          </>
        }
      />
      {simple && l.floors && <SimpleSite floorId={l.floors[0].id} locationId={l.id} canEdit={!!l.can_edit} />}
      <div className="grid-2">
        <Card
          title={simple ? 'Floors and rooms' : 'Floors'}
          actions={l.can_edit && <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal('floor')}>Add floor</Button>}
        >
          {simple && (
            <p className="small muted">
              Everything is on one floor. Open it to upload a floor plan and draw rooms, or add a floor, when you need them.
            </p>
          )}
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
              ['Site', l.site],
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

/** A one-floor location's racks and devices, shown on the location page. */
function SimpleSite({ floorId, locationId, canEdit }: { floorId: number; locationId: number; canEdit: boolean }) {
  const { project } = useProject();
  const nav = useNavigate();
  const floor = useLoad(() => api.get<Floor>(`/api/floors/${floorId}`), [floorId]);
  const [modal, setModal] = useState<'device' | 'place' | null>(null);
  if (!floor.data) return floor.error ? <ErrorBox error={floor.error} onRetry={floor.reload} /> : <Spinner />;
  const f = floor.data;
  const racks = f.racks ?? [];
  const devices = f.devices ?? [];
  const room = f.rooms?.find((r) => r.is_default) ?? f.rooms?.[0];
  return (
    <div className="stack mb">
      <Card title="Racks" actions={canEdit && <AddRackButton projectId={project.id} locationId={locationId} variant="ghost" />}>
        {racks.length === 0 ? (
          <Empty title="No racks yet">{canEdit ? 'Add one, then put devices in it.' : null}</Empty>
        ) : (
          <RackRow projectId={project.id} racks={racks} canEdit={canEdit} onChanged={floor.reload} />
        )}
      </Card>
      <Card
        title="Devices not in a rack"
        actions={
          canEdit &&
          room && (
            <>
              <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal('device')}>Add</Button>
              <Button variant="ghost" icon={<ArrowDownToLine size={15} />} onClick={() => setModal('place')}>Place from Unplaced</Button>
            </>
          )
        }
      >
        {devices.length === 0 ? (
          <p className="small muted">Access points, printers, desktops and other things that don't go in a rack.</p>
        ) : (
          <ul className="list">
            {devices.map((d) => (
              <li key={d.id}>
                <Link to={link.device(project.id, d.id)} className="row">
                  <strong className="mono">{d.code}</strong>
                  <span>{d.name}</span>
                  <span className="grow" />
                  <span className="small muted">{d.device_type.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {modal === 'device' && room && (
        <DeviceForm
          projectId={project.id}
          placement={{ type: 'room', room_id: room.id, x: null, y: null, rotation: null }}
          onClose={() => setModal(null)}
          onSaved={(d) => nav(link.device(project.id, d.id))}
        />
      )}
      {modal === 'place' && room && <PlaceInRoom projectId={project.id} roomId={room.id} onClose={() => setModal(null)} onSaved={floor.reload} />}
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
