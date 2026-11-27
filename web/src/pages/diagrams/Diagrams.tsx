// Topology diagrams: devices as boxes, links that can be backed by real
// cables (then coloured by the cable chain's state).
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Cable, Network, Plus, Save, Spline, Trash2, Type } from 'lucide-react';
import { ApiError, api, qs } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { Device, ListedPort } from '../../types';
import { Badge, Button, Card, Empty, ErrorBox, FormModal, PageHeader, SelectField, Spinner, Table, TextField, fmtTime, message, useLoad, useToast } from '../../ui';

interface Node {
  key: string;
  device_id: number | null;
  label: string | null;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  style: unknown;
  device?: { code: string; path: string; type: string } | null;
}
interface Edge {
  source: string;
  target: string;
  connection_id: number | null;
  label: string | null;
  style: unknown;
  cable?: { id: number; ends: string[]; chain_state: string } | null;
}
interface Diagram {
  id: number;
  name: string;
  description: string | null;
  version: number;
  updated_at: string;
  viewport: unknown;
  nodes: Node[];
  edges: Edge[];
  items: Record<string, unknown>[];
}

const W = 150;
const H = 46;

export function DiagramsPage() {
  const { project, canWrite } = useProject();
  const nav = useNavigate();
  const list = useLoad(
    () => api.get<{ topologies: { id: number; name: string; description: string | null; version: number; updated_at: string; nodes: number }[] }>(`/api/projects/${project.id}/topologies`).then((r) => r.topologies),
    [project.id],
  );
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  return (
    <div>
      <PageHeader title="Diagrams" subtitle="Network drawings; links can be backed by documented cables" actions={canWrite && <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>New diagram</Button>} />
      <ErrorBox error={list.error} onRetry={list.reload} />
      {!list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <Empty title="No diagrams yet" />
      ) : (
        <Table
          rows={list.data}
          rowKey={(d) => d.id}
          onRowClick={(d) => nav(link.diagram(project.id, d.id))}
          columns={[
            { key: 'name', label: 'Diagram', render: (d) => <Link to={link.diagram(project.id, d.id)}>{d.name}</Link>, sort: (d) => d.name },
            { key: 'desc', label: 'Description', render: (d) => d.description },
            { key: 'nodes', label: 'Boxes', render: (d) => d.nodes, className: 'num' },
            { key: 'updated', label: 'Changed', render: (d) => fmtTime(d.updated_at), sort: (d) => d.updated_at },
          ]}
        />
      )}
      {adding && (
        <FormModal
          title="New diagram"
          submitLabel="Create"
          onClose={() => setAdding(false)}
          onSubmit={async () => {
            const d = await api.post<Diagram>(`/api/projects/${project.id}/topologies`, { name });
            nav(link.diagram(project.id, d.id));
          }}
        >
          <TextField label="Name" required maxLength={80} placeholder="e.g. Core network" value={name} onChange={(e) => setName(e.target.value)} />
        </FormModal>
      )}
    </div>
  );
}

/** Cables between two devices (from the first device's ports). */
async function cablesBetween(a: number, b: number) {
  const ports = (await api.get<{ ports: ListedPort[] }>(`/api/devices/${a}/ports`)).ports;
  const out: { id: number; text: string }[] = [];
  for (const p of ports) {
    for (const c of [p.front, p.rear]) {
      if (c && c.far.device_id === b && !out.some((o) => o.id === c.connection_id)) out.push({ id: c.connection_id, text: `${p.code} ↔ ${c.far.path.split('/').pop()}${c.cable_type ? ` (${c.cable_type})` : ''}` });
    }
  }
  return out;
}

/** Devices one cable away (through panels, the far end of each cable). */
async function neighbours(deviceId: number) {
  const ports = (await api.get<{ ports: ListedPort[] }>(`/api/devices/${deviceId}/ports`)).ports;
  return ports.flatMap((p) => [p.front, p.rear]).filter((c): c is NonNullable<typeof c> => !!c && c.kind !== 'power');
}

export function DiagramPage() {
  const { project, canWrite } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const loaded = useLoad(() => api.get<Diagram>(`/api/topologies/${id}`), [id]);
  const [d, setD] = useState<Diagram | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; key: string } | null>(null);
  const [linking, setLinking] = useState<string | null | false>(false);
  const [modal, setModal] = useState<{ t: 'device' } | { t: 'label' } | { t: 'edge'; source: string; target: string } | { t: 'delete' } | null>(null);
  const [drag, setDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (loaded.data) {
      setD(loaded.data);
      setDirty(false);
    }
  }, [loaded.data]);
  if (loaded.error) return <ErrorBox error={loaded.error} onRetry={loaded.reload} />;
  if (!d) return <Spinner />;
  const edit = canWrite;
  const change = (patch: Partial<Diagram>) => {
    setD({ ...d, ...patch });
    setDirty(true);
  };
  const node = (k: string) => d.nodes.find((n) => n.key === k);
  const center = (n: Node): [number, number] => [n.x + (n.width ?? W) / 2, n.y + (n.height ?? H) / 2];
  const pt = (e: { clientX: number; clientY: number }) => {
    const m = svg.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return [p.x, p.y];
  };
  const free = (): [number, number] => {
    const maxY = d.nodes.reduce((m, n) => Math.max(m, n.y), 0);
    return [40 + (d.nodes.length % 5) * 190, d.nodes.length ? maxY + (d.nodes.length % 5 === 0 ? 110 : 0) : 40];
  };
  const addDevice = (dev: { id: number; code: string; path: string; type: string }, at?: [number, number]) => {
    const key = `d${dev.id}`;
    if (node(key)) return key;
    const [x, y] = at ?? free();
    d.nodes = [...d.nodes, { key, device_id: dev.id, label: null, x, y, width: null, height: null, style: null, device: { code: dev.code, path: dev.path, type: dev.type } }];
    return key;
  };

  const onNodeDown = (n: Node) => (e: RPointerEvent) => {
    e.stopPropagation();
    if (linking !== false) {
      if (linking === null) setLinking(n.key);
      else if (linking !== n.key) {
        setModal({ t: 'edge', source: linking, target: n.key });
        setLinking(false);
      }
      return;
    }
    setSel({ kind: 'node', key: n.key });
    if (!edit) return;
    const [x, y] = pt(e);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ key: n.key, dx: x - n.x, dy: y - n.y });
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    const [x, y] = pt(e);
    change({ nodes: d.nodes.map((n) => (n.key === drag.key ? { ...n, x: Math.max(0, Math.round(x - drag.dx)), y: Math.max(0, Math.round(y - drag.dy)) } : n)) });
  };

  const save = async () => {
    try {
      const body = {
        name: d.name,
        description: d.description,
        viewport: d.viewport,
        expected_version: d.version,
        nodes: d.nodes.map(({ key, device_id, label, x, y, width, height, style }) => ({ key, device_id, label, x, y, width, height, style })),
        edges: d.edges.map(({ source, target, connection_id, label, style }) => ({ source, target, connection_id, label, style })),
        items: d.items.map(({ kind, x, y, width, height, text, style }) => ({ kind, x, y, width, height, text, style })),
      };
      const saved = await api.put<Diagram>(`/api/topologies/${d.id}`, body);
      setD(saved);
      setDirty(false);
      setError(null);
      toast.ok('Saved');
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? 'Someone else saved this diagram meanwhile. Reload to see their version (your changes here will be lost).' : message(e));
    }
  };

  const expand = async (n: Node) => {
    if (!n.device_id) return;
    try {
      const cables = await neighbours(n.device_id);
      const nodes = [...d.nodes];
      const edges = [...d.edges];
      let i = 0;
      for (const c of cables) {
        const key = `d${c.far.device_id}`;
        if (!nodes.some((x) => x.key === key)) {
          const dev = await api.get<Device>(`/api/devices/${c.far.device_id}`);
          nodes.push({ key, device_id: dev.id, label: null, x: Math.max(20, n.x + (i % 4) * 180 - 270), y: n.y + 130 + Math.floor(i / 4) * 90, width: null, height: null, style: null, device: { code: dev.code, path: dev.path, type: dev.device_type.key } });
          i++;
        }
        if (!edges.some((x) => x.connection_id === c.connection_id)) edges.push({ source: n.key, target: key, connection_id: c.connection_id, label: null, style: null });
      }
      change({ nodes, edges });
      toast.ok(cables.length ? `Added ${cables.length} cabled link(s)` : 'No cables on this device');
    } catch (e) {
      toast.error(e);
    }
  };

  const selNode = sel?.kind === 'node' ? node(sel.key) : undefined;
  const selEdge = sel?.kind === 'edge' ? d.edges.find((e) => `${e.source}>${e.target}` === sel.key) : undefined;
  const width = Math.max(1000, ...d.nodes.map((n) => n.x + (n.width ?? W) + 60));
  const height = Math.max(600, ...d.nodes.map((n) => n.y + (n.height ?? H) + 60));
  return (
    <div>
      <nav className="crumbs"><Link to={link.diagrams(project.id)}>Diagrams</Link></nav>
      <PageHeader
        title={<>{d.name} {dirty && <Badge tone="warn">unsaved</Badge>}</>}
        subtitle={`version ${d.version} · ${d.nodes.length} box(es) · ${d.edges.length} link(s)`}
        actions={
          edit && (
            <>
              <Button variant="primary" icon={<Save size={15} />} disabled={!dirty} onClick={save}>Save</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal({ t: 'delete' })}>Delete</Button>
            </>
          )
        }
      />
      <ErrorBox error={error} onRetry={error?.startsWith('Someone') ? () => { setError(null); loaded.reload(); } : undefined} />
      {edit && (
        <div className="row toolbar">
          <Button icon={<Network size={15} />} onClick={() => setModal({ t: 'device' })}>Add device</Button>
          <Button icon={<Type size={15} />} onClick={() => setModal({ t: 'label' })}>Add text box</Button>
          <Button icon={<Spline size={15} />} variant={linking !== false ? 'primary' : 'secondary'} onClick={() => setLinking(linking === false ? null : false)}>
            {linking === false ? 'Draw a link' : linking === null ? 'Click the first box…' : 'Click the second box…'}
          </Button>
        </div>
      )}
      <div className="diagram-layout">
        <div className="diagram-wrap">
          <svg ref={svg} className="diagram" width={width} height={height} onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerDown={() => setSel(null)} aria-label="Diagram">
            {d.edges.map((e) => {
              const a = node(e.source);
              const b = node(e.target);
              if (!a || !b) return null;
              const [x1, y1] = center(a);
              const [x2, y2] = center(b);
              const k = `${e.source}>${e.target}`;
              const state = e.cable?.chain_state ?? (e.connection_id ? 'complete' : 'plain');
              return (
                <g key={k} className={`d-edge s-${state}${sel?.key === k ? ' selected' : ''}`} onPointerDown={(ev) => { ev.stopPropagation(); setSel({ kind: 'edge', key: k }); }}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} className="hit" />
                  <line x1={x1} y1={y1} x2={x2} y2={y2} />
                  {e.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6}>{e.label}</text>}
                </g>
              );
            })}
            {d.nodes.map((n) => (
              <g key={n.key} className={`d-node${n.device_id ? ' device' : ' text'}${sel?.key === n.key ? ' selected' : ''}${linking === n.key ? ' linking' : ''}`} transform={`translate(${n.x} ${n.y})`} onPointerDown={onNodeDown(n)} onDoubleClick={() => n.device_id && nav(link.device(project.id, n.device_id))} data-node={n.device?.code ?? n.label ?? n.key}>
                <rect width={n.width ?? W} height={n.height ?? H} rx={6} />
                <text x={10} y={19} className="code">{n.device?.code ?? n.label}</text>
                {n.device && <text x={10} y={36} className="sub">{n.label ?? n.device.type}</text>}
              </g>
            ))}
          </svg>
        </div>
        <aside className="stack">
          {selNode && (
            <Card title={selNode.device?.code ?? 'Text box'}>
              <div className="stack">
                {selNode.device && <Link to={link.device(project.id, selNode.device_id!)}>{selNode.device.path.split('/').slice(1).join(' / ')}</Link>}
                {edit && <TextField label={selNode.device ? 'Caption' : 'Text'} value={selNode.label ?? ''} onChange={(e) => change({ nodes: d.nodes.map((n) => (n.key === selNode.key ? { ...n, label: e.target.value || null } : n)) })} />}
                {edit && selNode.device_id && <Button icon={<Cable size={15} />} onClick={() => expand(selNode)}>Add what it's cabled to</Button>}
                {edit && <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => { change({ nodes: d.nodes.filter((n) => n.key !== selNode.key), edges: d.edges.filter((e) => e.source !== selNode.key && e.target !== selNode.key) }); setSel(null); }}>Remove box</Button>}
              </div>
            </Card>
          )}
          {selEdge && (
            <Card title="Link">
              <div className="stack">
                {selEdge.cable ? <div className="small">Cable {selEdge.cable.ends.map((p) => p.split('/').slice(-2).join(' ')).join(' ↔ ')} · <Badge tone={selEdge.cable.chain_state === 'complete' ? 'ok' : 'warn'}>{selEdge.cable.chain_state}</Badge></div> : <div className="small muted">{selEdge.connection_id ? 'Cable (save to see its state)' : 'A drawn link, not a documented cable'}</div>}
                {edit && <TextField label="Label" value={selEdge.label ?? ''} onChange={(e) => change({ edges: d.edges.map((x) => (x === selEdge ? { ...x, label: e.target.value || null } : x)) })} />}
                {edit && <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => { change({ edges: d.edges.filter((x) => x !== selEdge) }); setSel(null); }}>Remove link</Button>}
              </div>
            </Card>
          )}
          {!selNode && !selEdge && (
            <Card title="How it works">
              <p className="small">Drag boxes to arrange them. Links backed by a cable are green when the chain is complete and amber when it isn't. Double-click a device to open it.</p>
            </Card>
          )}
        </aside>
      </div>
      {modal?.t === 'device' && (
        <AddDevice
          projectId={project.id}
          onClose={() => setModal(null)}
          onPick={(dev) => {
            const key = addDevice({ id: dev.id, code: dev.code, path: dev.path, type: dev.device_type.key });
            change({ nodes: [...d.nodes] });
            setSel({ kind: 'node', key });
          }}
        />
      )}
      {modal?.t === 'label' && <AddLabel onClose={() => setModal(null)} onAdd={(text) => { const [x, y] = free(); change({ nodes: [...d.nodes, { key: `t${Date.now()}`, device_id: null, label: text, x, y, width: null, height: null, style: null }] }); }} />}
      {modal?.t === 'edge' && (
        <EdgeForm
          a={node(modal.source)!}
          b={node(modal.target)!}
          onClose={() => setModal(null)}
          onAdd={(connection_id) => change({ edges: [...d.edges, { source: modal.source, target: modal.target, connection_id, label: null, style: null }] })}
        />
      )}
      {modal?.t === 'delete' && (
        <FormModal title={`Delete ${d.name}`} submitLabel="Delete" danger onClose={() => setModal(null)} onSubmit={async () => { await api.del(`/api/topologies/${d.id}`); nav(link.diagrams(project.id)); }}>
          <p>Only the drawing is deleted; devices and cables stay.</p>
        </FormModal>
      )}
    </div>
  );
}

function AddDevice({ projectId, onClose, onPick }: { projectId: number; onClose: () => void; onPick: (d: Device) => void }) {
  const [q, setQ] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [pick, setPick] = useState('');
  useEffect(() => {
    const t = setTimeout(() => api.get<{ devices: Device[] }>(`/api/projects/${projectId}/devices${qs({ q, limit: 50 })}`).then((r) => setDevices(r.devices), () => setDevices([])), 200);
    return () => clearTimeout(t);
  }, [q, projectId]);
  const chosen = devices.find((x) => String(x.id) === pick) ?? devices[0];
  return (
    <FormModal title="Add a device" submitLabel="Add" onClose={onClose} onSubmit={async () => { if (!chosen) throw new Error('Choose a device'); onPick(chosen); }}>
      <TextField label="Find a device" placeholder="Code, name, hostname…" value={q} onChange={(e) => setQ(e.target.value)} />
      <SelectField label="Device" value={chosen ? String(chosen.id) : ''} onChange={(e) => setPick(e.target.value)} options={devices.map((x) => ({ value: String(x.id), label: x.path.split('/').slice(1).join(' / ') }))} />
    </FormModal>
  );
}

function AddLabel({ onClose, onAdd }: { onClose: () => void; onAdd: (t: string) => void }) {
  const [t, setT] = useState('');
  return (
    <FormModal title="Add a text box" submitLabel="Add" onClose={onClose} onSubmit={async () => onAdd(t)}>
      <TextField label="Text" required maxLength={200} placeholder="e.g. Internet" value={t} onChange={(e) => setT(e.target.value)} />
    </FormModal>
  );
}

function EdgeForm({ a, b, onClose, onAdd }: { a: Node; b: Node; onClose: () => void; onAdd: (connectionId: number | null) => void }) {
  const [cables, setCables] = useState<{ id: number; text: string }[] | null>(a.device_id && b.device_id ? null : []);
  const [pick, setPick] = useState('');
  useEffect(() => {
    if (a.device_id && b.device_id) cablesBetween(a.device_id, b.device_id).then((c) => { setCables(c); setPick(c[0] ? String(c[0].id) : ''); }, () => setCables([]));
  }, [a.device_id, b.device_id]);
  return (
    <FormModal title={`Link ${a.device?.code ?? a.label} and ${b.device?.code ?? b.label}`} submitLabel="Add link" onClose={onClose} onSubmit={async () => onAdd(pick ? Number(pick) : null)}>
      {cables === null ? (
        <Spinner />
      ) : (
        <SelectField
          label="Backed by"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          options={[...cables.map((c) => ({ value: String(c.id), label: `Cable ${c.text}` })), { value: '', label: 'Nothing (just a drawn line)' }]}
        />
      )}
      {cables?.length === 0 && a.device_id && b.device_id && <p className="small muted">No cable joins these two devices directly.</p>}
    </FormModal>
  );
}
