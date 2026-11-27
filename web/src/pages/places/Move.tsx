// Moving racks, floors and locations, always previewed first: the dry run
// shows the new path, cables that would be cut, a code clash (with the
// suggested code filled in) and, between projects, what carries across.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../api';
import type { Project } from '../../types';
import { Badge, FormModal, SelectField, Spinner, TextField, Warnings } from '../../ui';
import type { PlaceOption } from '../devices/DeviceForm';

export interface MoveResult {
  dry_run: boolean;
  from: string;
  to: string;
  project_id: number;
  project_changed: boolean;
  report: {
    cables_cut: string[];
    code_clash: { code: string; suggested: string } | null;
    vlans: { vid: number; name: string; action: string }[];
    wlans: { ssid: string; action: string }[];
    templates_copied: string[];
    types_copied: string[];
    tags_copied: string[];
    addresses_unlinked: number;
    diagram_boxes_unlinked: number;
    integration_links_cleared: number;
    responsible_cleared: string[];
  };
}

const show = (p: string) => p.split('/').join(' / ');

export function MovePreview({ r }: { r: MoveResult }) {
  const x = r.report;
  const lines: ReactNode[] = [];
  if (x.cables_cut.length) lines.push(<>{x.cables_cut.length} cable(s) are removed, because they'd now join different floors: <ul className="small">{x.cables_cut.map((c) => <li key={c}>{c}</li>)}</ul></>);
  if (r.project_changed) {
    for (const v of x.vlans) lines.push(<>VLAN {v.vid} {v.name}: {v.action}</>);
    for (const w of x.wlans) lines.push(<>Wi-Fi {w.ssid}: {w.action}</>);
    if (x.templates_copied.length) lines.push(<>Templates copied: {x.templates_copied.join(', ')}</>);
    if (x.types_copied.length) lines.push(<>Device types copied: {x.types_copied.join(', ')}</>);
    if (x.tags_copied.length) lines.push(<>Tags copied: {x.tags_copied.join(', ')}</>);
    if (x.addresses_unlinked) lines.push(<>{x.addresses_unlinked} IP address(es) stay in the old project's IP plan, no longer linked to the devices</>);
    if (x.diagram_boxes_unlinked) lines.push(<>{x.diagram_boxes_unlinked} diagram box(es) in the old project become plain labels</>);
    if (x.integration_links_cleared) lines.push(<>{x.integration_links_cleared} device(s) stop being updated by the old project's integrations</>);
    if (x.responsible_cleared.length) lines.push(<>No longer responsible (they can't see the target project): {x.responsible_cleared.join(', ')}</>);
  }
  return (
    <div className="move-preview stack">
      <div className="small">
        <span className="mono">{show(r.from)}</span> → <strong className="mono">{show(r.to)}</strong>
      </div>
      {x.code_clash && <Warnings items={[`The code ${x.code_clash.code} is already used there; it will be ${x.code_clash.suggested} (you can change it).`]} />}
      {lines.length === 0 ? (
        <p className="small"><Badge tone="ok">Nothing else changes</Badge></p>
      ) : (
        <ul className="list small">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      )}
    </div>
  );
}

/** A dialog that previews a move, then does it. `target` is null until
 * the user has chosen where to. */
export function MoveDialog({
  title,
  resource,
  target,
  crossProject,
  children,
  onClose,
  onMoved,
}: {
  title: string;
  resource: { type: 'device' | 'rack' | 'floor' | 'location'; id: number };
  target: Record<string, unknown> | null;
  crossProject?: boolean;
  children: ReactNode;
  onClose: () => void;
  onMoved: (r: MoveResult) => void;
}) {
  const [code, setCode] = useState('');
  const [networks, setNetworks] = useState('reuse');
  const [preview, setPreview] = useState<MoveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const key = JSON.stringify([target, code, networks]);
  const body = (dry: boolean) => ({ resource, target, code: code || undefined, networks: crossProject ? networks : undefined, dry_run: dry });
  useEffect(() => {
    setPreview(null);
    if (!target) return;
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.post<MoveResult>('/api/moves', body(true)).then(
        (r) => {
          if (!live) return;
          setPreview(r);
          if (r.report.code_clash && !code) setCode(r.report.code_clash.suggested);
        },
        () => live && setPreview(null),
      ).finally(() => live && setLoading(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormModal
      title={title}
      submitLabel="Move"
      wide
      onClose={onClose}
      onSubmit={async () => {
        if (!target) throw new Error('Choose where to move it');
        onMoved(await api.post<MoveResult>('/api/moves', body(false)));
      }}
    >
      {children}
      <div className="grid-2">
        <TextField label="Code there" placeholder="Keep its code" hint="Only needed when the code is taken" value={code} onChange={(e) => setCode(e.target.value)} />
        {crossProject && (
          <SelectField
            label="VLANs and Wi-Fi"
            value={networks}
            onChange={(e) => setNetworks(e.target.value)}
            options={[
              { value: 'reuse', label: 'Reuse identical ones there, copy the rest' },
              { value: 'copy', label: 'Copy them where the number is free' },
              { value: 'clear', label: 'Clear the assignments' },
            ]}
          />
        )}
      </div>
      <h4 className="form-section">What happens</h4>
      {!target ? <p className="small muted">Choose where to move it.</p> : loading && !preview ? <Spinner label="Checking…" /> : preview ? <MovePreview r={preview} /> : <p className="small muted">The move can't be checked; Move shows why.</p>}
    </FormModal>
  );
}

export function useAllProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    api.get<Project[]>('/api/projects').then(setProjects, () => setProjects([]));
  }, []);
  return projects;
}

function usePlaces(projectId: number | null, kind: PlaceOption['kind']) {
  const [list, setList] = useState<PlaceOption[] | null>(null);
  useEffect(() => {
    setList(null);
    if (!projectId) return;
    api.get<PlaceOption[]>(`/api/projects/${projectId}/places`).then((p) => setList(p.filter((x) => x.kind === kind)), () => setList([]));
  }, [projectId, kind]);
  return list;
}

export function MoveRack({ projectId, rackId, roomId, onClose, onMoved }: { projectId: number; rackId: number; roomId: number; onClose: () => void; onMoved: (r: MoveResult) => void }) {
  const rooms = usePlaces(projectId, 'room');
  const [room, setRoom] = useState('');
  return (
    <MoveDialog title="Move rack" resource={{ type: 'rack', id: rackId }} target={room ? { room_id: Number(room) } : null} onClose={onClose} onMoved={onMoved}>
      <SelectField
        label="To room"
        value={room}
        onChange={(e) => setRoom(e.target.value)}
        options={[{ value: '', label: rooms ? 'Choose…' : 'Loading…' }, ...(rooms ?? []).filter((r) => r.id !== roomId).map((r) => ({ value: String(r.id), label: show(r.path.split('/').slice(1).join('/')) }))]}
      />
    </MoveDialog>
  );
}

export function MoveFloor({ projectId, floorId, locationId, onClose, onMoved }: { projectId: number; floorId: number; locationId: number; onClose: () => void; onMoved: (r: MoveResult) => void }) {
  const projects = useAllProjects();
  const [project, setProject] = useState(String(projectId));
  const locations = usePlaces(Number(project), 'location');
  const [loc, setLoc] = useState('');
  return (
    <MoveDialog
      title="Move floor"
      resource={{ type: 'floor', id: floorId }}
      target={loc ? { location_id: Number(loc) } : null}
      crossProject={Number(project) !== projectId}
      onClose={onClose}
      onMoved={onMoved}
    >
      <div className="grid-2">
        <SelectField label="Project" value={project} onChange={(e) => { setProject(e.target.value); setLoc(''); }} options={(projects ?? []).map((p) => ({ value: String(p.id), label: `${p.code} · ${p.name}` }))} />
        <SelectField
          label="To location"
          value={loc}
          onChange={(e) => setLoc(e.target.value)}
          options={[{ value: '', label: locations ? 'Choose…' : 'Loading…' }, ...(locations ?? []).filter((l) => l.id !== locationId).map((l) => ({ value: String(l.id), label: show(l.path.split('/').slice(1).join('/')) }))]}
        />
      </div>
    </MoveDialog>
  );
}

export function MoveLocation({ projectId, locationId, onClose, onMoved }: { projectId: number; locationId: number; onClose: () => void; onMoved: (r: MoveResult) => void }) {
  const projects = useAllProjects();
  const [to, setTo] = useState('');
  return (
    <MoveDialog title="Move location to another project" resource={{ type: 'location', id: locationId }} target={to ? { project_id: Number(to) } : null} crossProject onClose={onClose} onMoved={onMoved}>
      <SelectField
        label="To project"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        options={[{ value: '', label: projects ? 'Choose…' : 'Loading…' }, ...(projects ?? []).filter((p) => p.id !== projectId && p.can_edit !== false).map((p) => ({ value: String(p.id), label: `${p.code} · ${p.name}` }))]}
      />
    </MoveDialog>
  );
}
