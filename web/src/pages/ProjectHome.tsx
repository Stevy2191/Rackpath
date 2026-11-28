import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDownToLine, Check, MapPin, Plus } from 'lucide-react';
import { api, qs } from '../api';
import { useProject } from '../layout/Shell';
import { link } from '../links';
import type { Device } from '../types';
import { Button, Card, Empty, ErrorBox, PageHeader, Spinner, useLoad } from '../ui';
import { ReportButton } from './Exports';
import { LocationForm } from './places/Locations';
import { AddRackButton } from './places/Quick';

interface LocationSummary {
  id: number;
  code: string;
  name: string | null;
  address_city: string | null;
  site: string | null;
  counts: { floors: number; rooms: number; racks: number; devices: number };
}

export function ProjectHome() {
  const { project, canWrite } = useProject();
  const nav = useNavigate();
  const locations = useLoad(() => api.get<LocationSummary[]>(`/api/projects/${project.id}/locations`), [project.id]);
  const unplaced = useLoad(
    () => api.get<{ devices: Device[]; next_after_id: number | null }>(`/api/projects/${project.id}/devices${qs({ unplaced: true, limit: 200 })}`),
    [project.id],
  );
  const [addingLocation, setAddingLocation] = useState(false);
  const totals = (locations.data ?? []).reduce(
    (a, l) => ({ racks: a.racks + l.counts.racks, devices: a.devices + l.counts.devices, rooms: a.rooms + l.counts.rooms }),
    { racks: 0, devices: 0, rooms: 0 },
  );
  const waiting = unplaced.data?.devices.length ?? 0;
  const waitingLabel = `${waiting}${unplaced.data?.next_after_id ? '+' : ''}`;
  return (
    <div>
      <PageHeader
        title={project.name}
        subtitle={project.code}
        actions={
          <>
            {canWrite && (locations.data?.length ?? 0) > 0 && <AddRackButton projectId={project.id} />}
            <ReportButton type="project" id={project.id} label="Project report (PDF)" />
          </>
        }
      />
      {project.description && <p className="muted">{project.description}</p>}
      <ErrorBox error={locations.error} onRetry={locations.reload} />
      {locations.loading && !locations.data && <Spinner />}
      {locations.data && (
        <>
          {canWrite && (
            <GetStarted
              hasLocation={locations.data.length > 0}
              hasRack={totals.racks > 0}
              hasPlaced={totals.devices > 0}
              projectId={project.id}
              onAddLocation={() => setAddingLocation(true)}
            />
          )}
          {waiting > 0 && (
            <div className="notice row mb" role="status">
              <ArrowDownToLine size={16} />
              <span>
                <strong>{waitingLabel} device(s)</strong> are waiting in Unplaced (often from an integration). Open a rack or room and use <em>Place a device</em>, or
                edit each one to choose its place.
              </span>
              <span className="grow" />
              <Link to={`/p/${project.id}/devices?unplaced=1`}>See them</Link>
            </div>
          )}
          <div className="grid-3" style={{ marginBottom: '1.25rem' }}>
            <Card title="Locations"><div className="stat">{locations.data.length}</div></Card>
            <Card title="Rooms"><div className="stat">{totals.rooms}</div></Card>
            <Card title="Racks"><div className="stat">{totals.racks}</div></Card>
            <Card title="Placed devices"><div className="stat">{totals.devices}</div></Card>
          </div>
          {locations.data.length === 0 ? (
            <Empty title="No locations yet">
              A location is a building: your house, an office, a data centre. Add one to start placing racks and devices.
            </Empty>
          ) : (
            <div className="grid-3">
              {locations.data.map((l) => (
                <Link key={l.id} to={link.location(project.id, l.id)} className="card" style={{ color: 'inherit' }}>
                  <div className="card-body">
                    <div className="row">
                      <MapPin size={16} />
                      <strong className="mono">{l.code}</strong>
                    </div>
                    <div>{l.name}</div>
                    {l.site && <div className="small muted">{l.site}</div>}
                    <div className="small muted">
                      {l.counts.floors} floor(s) · {l.counts.racks} rack(s) · {l.counts.devices} device(s)
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
      {addingLocation && (
        <LocationForm projectId={project.id} onClose={() => setAddingLocation(false)} onSaved={(l) => nav(link.location(project.id, l.id))} />
      )}
    </div>
  );
}

/** Three steps for a new project; gone once they're all done. */
function GetStarted({
  hasLocation,
  hasRack,
  hasPlaced,
  projectId,
  onAddLocation,
}: {
  hasLocation: boolean;
  hasRack: boolean;
  hasPlaced: boolean;
  projectId: number;
  onAddLocation: () => void;
}) {
  if (hasLocation && hasRack && hasPlaced) return null;
  const Step = ({ done, n, title, children }: { done: boolean; n: number; title: string; children: ReactNode }) => (
    <li className={`step${done ? ' step-done' : ''}`}>
      <span className="step-n" aria-hidden>{done ? <Check size={14} /> : n}</span>
      <div className="stack">
        <strong>{title}</strong>
        {!done && children}
      </div>
    </li>
  );
  return (
    <Card title="Get started" className="mb">
      <ol className="steps">
        <Step done={hasLocation} n={1} title="Add a location">
          <span className="small muted">A building: your house, an office, a data centre. It gets a floor and room by itself.</span>
          <div>
            <Button variant="primary" icon={<Plus size={15} />} onClick={onAddLocation}>Add location</Button>
          </div>
        </Step>
        <Step done={hasRack} n={2} title="Add a rack">
          <span className="small muted">Its height in U and where it is. Skip this if nothing you have is rack-mounted.</span>
          {hasLocation && (
            <div>
              <AddRackButton projectId={projectId} variant="primary" />
            </div>
          )}
        </Step>
        <Step done={hasPlaced} n={3} title="Put devices in it">
          <span className="small muted">
            Open the rack and click a free U to add a device, or place one an integration brought in. Things that don't go in a rack (access points, desktops) go in
            the location's room.
          </span>
        </Step>
      </ol>
    </Card>
  );
}
