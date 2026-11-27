import { Link } from 'react-router-dom';
import { MapPin } from 'lucide-react';
import { api } from '../api';
import { useProject } from '../layout/Shell';
import { link } from '../links';
import { Card, Empty, ErrorBox, PageHeader, Spinner, useLoad } from '../ui';

interface LocationSummary {
  id: number;
  code: string;
  name: string | null;
  address_city: string | null;
  counts: { floors: number; rooms: number; racks: number; devices: number };
}

export function ProjectHome() {
  const { project } = useProject();
  const locations = useLoad(() => api.get<LocationSummary[]>(`/api/projects/${project.id}/locations`), [project.id]);
  const totals = (locations.data ?? []).reduce(
    (a, l) => ({ racks: a.racks + l.counts.racks, devices: a.devices + l.counts.devices, rooms: a.rooms + l.counts.rooms }),
    { racks: 0, devices: 0, rooms: 0 },
  );
  return (
    <div>
      <PageHeader title={project.name} subtitle={project.code} />
      {project.description && <p className="muted">{project.description}</p>}
      <ErrorBox error={locations.error} onRetry={locations.reload} />
      {locations.loading && !locations.data && <Spinner />}
      {locations.data && (
        <>
          <div className="grid-3" style={{ marginBottom: '1.25rem' }}>
            <Card title="Locations"><div className="stat">{locations.data.length}</div></Card>
            <Card title="Rooms"><div className="stat">{totals.rooms}</div></Card>
            <Card title="Racks"><div className="stat">{totals.racks}</div></Card>
            <Card title="Placed devices"><div className="stat">{totals.devices}</div></Card>
          </div>
          {locations.data.length === 0 ? (
            <Empty title="No locations yet">Add the first site to start documenting.</Empty>
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
    </div>
  );
}
