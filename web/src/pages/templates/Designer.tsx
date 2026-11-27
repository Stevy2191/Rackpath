// The template designer: draw port groups on the device's faces, set
// their ports, and the template's height and power figures. Port names
// come from the server's own preview, so they match what devices get.
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Copy, Save, Trash2 } from 'lucide-react';
import { ApiError, api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { PortGroup, Template, TemplateImpact, TemplateIn } from '../../types';
import { Badge, Button, Card, Checkbox, ErrorBox, FormModal, Modal, PageHeader, SelectField, Spinner, TextArea, TextField, message, useLoad, useToast } from '../../ui';
import { useMedia } from '../cabling/media';
import { num, useDeviceTypes } from '../places/common';
import { PowerFields } from '../power/Power';

type Face = 'front' | 'rear';
type Preview = { grid: { rows: number; cols: number }; ports: Template['ports'] };

const KEYS: (keyof TemplateIn)[] = ['name', 'device_type', 'manufacturer', 'model', 'u_height', 'depth', 'half_width', 'power', 'notes', 'port_groups', 'port_overrides', 'elements'];
const toInput = (t: Template): TemplateIn => Object.fromEntries(KEYS.map((k) => [k, t[k]])) as unknown as TemplateIn;

const COLORS = ['#0ea5e9', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899', '#84cc16'];

export function TemplatePage() {
  const { project, canWrite } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const types = useDeviceTypes(project.id);
  const tpl = useLoad(() => api.get<Template>(`/api/templates/${id}`), [id]);
  const [draft, setDraft] = useState<TemplateIn | null>(null);
  const [dirty, setDirty] = useState(false);
  const [face, setFace] = useState<Face>('front');
  const [sel, setSel] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ impacts: TemplateImpact[]; confirm: boolean } | null>(null);

  useEffect(() => {
    if (tpl.data) {
      setDraft(toInput(tpl.data));
      setPreview({ grid: tpl.data.grid, ports: tpl.data.ports });
      setDirty(false);
    }
  }, [tpl.data]);

  // Live preview of the draft.
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    if (!draft || !dirty) return;
    const t = setTimeout(() => {
      api.post<Preview>(`/api/projects/${project.id}/templates/preview`, draft).then(
        (p) => {
          setPreview(p);
          setPreviewError(null);
        },
        (e) => setPreviewError(message(e)),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (tpl.error) return <ErrorBox error={tpl.error} onRetry={tpl.reload} />;
  if (!tpl.data || !draft) return <Spinner />;
  const t = tpl.data;
  const editable = canWrite && !t.builtin;
  const update = (patch: Partial<TemplateIn>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const setGroup = (i: number, patch: Partial<PortGroup>) => update({ port_groups: draft.port_groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
  const group = sel != null ? draft.port_groups[sel] : undefined;

  const save = async (confirmName?: string) => {
    try {
      if (confirmName === undefined) {
        const dry = await api.put<{ needs_confirmation: boolean; devices: TemplateImpact[] }>(`/api/templates/${t.id}?dry_run=true`, draft);
        if (dry.devices.length > 0) return setSaving({ impacts: dry.devices, confirm: dry.needs_confirmation });
      }
      await api.put(`/api/templates/${t.id}`, { ...draft, confirm_name: confirmName });
      toast.ok(t.device_count ? `Saved; ${t.device_count} device(s) updated` : 'Saved');
      setSaving(null);
      tpl.reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return setSaving({ impacts: (e.body as { devices: TemplateImpact[] }).devices, confirm: true });
      toast.error(e);
    }
  };

  return (
    <div>
      <nav className="crumbs">
        <Link to={link.templates(project.id)}>Device templates</Link>
      </nav>
      <PageHeader
        title={<>{draft.name} {t.builtin && <Badge>built-in</Badge>} {dirty && <Badge tone="warn">unsaved</Badge>}</>}
        subtitle={`${draft.device_type} · ${draft.u_height == null ? 'not rack-mounted' : draft.u_height === 0 ? 'zero-U' : `${draft.u_height}U`} · ${preview?.ports.length ?? 0} ports · version ${t.version} · ${t.device_count} device(s)`}
        actions={
          t.builtin ? (
            canWrite && (
              <Button
                variant="primary"
                icon={<Copy size={15} />}
                onClick={async () => {
                  const copy = await api.post<Template>(`/api/templates/${t.id}/duplicate`, { project_id: project.id });
                  nav(link.template(project.id, copy.id));
                }}
              >
                Copy to project to edit
              </Button>
            )
          ) : (
            editable && (
              <>
                <Button variant="primary" icon={<Save size={15} />} disabled={!dirty || !!previewError} onClick={() => save()}>Save</Button>
                <Button variant="ghost" disabled={!dirty} onClick={() => { setDraft(toInput(t)); setPreview({ grid: t.grid, ports: t.ports }); setDirty(false); setSel(null); }}>Discard changes</Button>
                <DeleteTemplate t={t} onDone={() => nav(link.templates(project.id))} />
              </>
            )
          )
        }
      />
      <ErrorBox error={previewError} />
      <div className="designer">
        <div className="stack">
          <div className="row">
            <div className="segmented" role="group" aria-label="Face">
              {(['front', 'rear'] as Face[]).map((x) => (
                <button key={x} type="button" aria-pressed={face === x} onClick={() => setFace(x)}>{x === 'front' ? 'Front' : 'Rear'}</button>
              ))}
            </div>
            {editable && <span className="small muted">Drag across empty cells to add a port group; click a group to edit it.</span>}
          </div>
          {preview && (
            <FaceGrid
              grid={preview.grid}
              face={face}
              groups={draft.port_groups}
              ports={preview.ports}
              selected={sel}
              editable={editable}
              onSelect={setSel}
              onDraw={(r, c, rows, cols) => {
                update({
                  port_groups: [...draft.port_groups, { face, grid_row: r, grid_col: c, rows, cols, prefix: '', numbering: 'column_major', role: null }],
                });
                setSel(draft.port_groups.length);
              }}
            />
          )}
        </div>
        <aside className="stack">
          {group && sel != null ? (
            <GroupPanel
              key={sel}
              group={group}
              index={sel}
              editable={editable}
              onChange={(p) => setGroup(sel, p)}
              onDelete={() => {
                update({ port_groups: draft.port_groups.filter((_, j) => j !== sel) });
                setSel(null);
              }}
              onClose={() => setSel(null)}
            />
          ) : (
            <Card title="Template">
              <fieldset disabled={!editable} className="plain">
                <TextField label="Name" value={draft.name} onChange={(e) => update({ name: e.target.value })} />
                <SelectField label="Device type" value={draft.device_type} onChange={(e) => update({ device_type: e.target.value })} options={(types.data ?? []).map((x) => ({ value: x.key, label: x.label }))} />
                <div className="grid-2">
                  <TextField label="Manufacturer" value={draft.manufacturer ?? ''} onChange={(e) => update({ manufacturer: e.target.value })} />
                  <TextField label="Model" value={draft.model ?? ''} onChange={(e) => update({ model: e.target.value })} />
                  <TextField
                    label="Height (U)"
                    type="number"
                    min={0}
                    step={0.5}
                    hint="0 = zero-U; blank = not rack-mounted"
                    value={draft.u_height ?? ''}
                    onChange={(e) => update({ u_height: e.target.value === '' ? null : num(e.target.value) })}
                  />
                  <SelectField label="Depth" value={draft.depth ?? ''} onChange={(e) => update({ depth: e.target.value || null })} options={[{ value: '', label: 'Not set' }, { value: 'half', label: 'Half depth' }, { value: 'full', label: 'Full depth' }]} />
                </div>
                <Checkbox label="Half width (two side by side)" checked={!!draft.half_width} onChange={(c) => update({ half_width: c })} />
                <TextArea label="Notes" value={draft.notes ?? ''} onChange={(e) => update({ notes: e.target.value })} />
                <h4 className="form-section">Power</h4>
                <PowerFields value={draft.power ?? {}} onChange={(p) => update({ power: p })} kind={draft.device_type} />
              </fieldset>
            </Card>
          )}
        </aside>
      </div>
      {saving && (
        <SaveImpact
          name={t.name}
          impacts={saving.impacts}
          confirm={saving.confirm}
          onClose={() => setSaving(null)}
          onSave={(n) => save(n ?? '')}
        />
      )}
    </div>
  );
}

function FaceGrid({
  grid,
  face,
  groups,
  ports,
  selected,
  editable,
  onSelect,
  onDraw,
}: {
  grid: { rows: number; cols: number };
  face: Face;
  groups: PortGroup[];
  ports: Template['ports'];
  selected: number | null;
  editable: boolean;
  onSelect: (i: number | null) => void;
  onDraw: (row: number, col: number, rows: number, cols: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ r0: number; c0: number; r1: number; c1: number } | null>(null);
  const cell = (e: { clientX: number; clientY: number }) => {
    const b = ref.current!.getBoundingClientRect();
    return {
      r: Math.max(0, Math.min(grid.rows - 1, Math.floor(((e.clientY - b.top) / b.height) * grid.rows))),
      c: Math.max(0, Math.min(grid.cols - 1, Math.floor(((e.clientX - b.left) / b.width) * grid.cols))),
    };
  };
  const taken = (r: number, c: number) => groups.some((g) => g.face === face && r >= g.grid_row && r < g.grid_row + g.rows && c >= g.grid_col && c < g.grid_col + g.cols);
  const down = (e: RPointerEvent) => {
    if (!editable) return;
    const { r, c } = cell(e);
    if (taken(r, c)) return;
    ref.current!.setPointerCapture(e.pointerId);
    setDrag({ r0: r, c0: c, r1: r, c1: c });
  };
  const move = (e: RPointerEvent) => {
    if (!drag) return;
    const { r, c } = cell(e);
    setDrag({ ...drag, r1: r, c1: c });
  };
  const up = () => {
    if (!drag) return;
    const r = Math.min(drag.r0, drag.r1);
    const c = Math.min(drag.c0, drag.c1);
    setDrag(null);
    onDraw(r, c, Math.abs(drag.r1 - drag.r0) + 1, Math.abs(drag.c1 - drag.c0) + 1);
  };
  const wide = grid.cols > 8;
  return (
    <div className="face-wrap">
      <div
        ref={ref}
        className={`face-grid${wide ? '' : ' narrow'}`}
        style={{ gridTemplateColumns: `repeat(${grid.cols}, 1fr)`, gridTemplateRows: `repeat(${grid.rows}, var(--cell))`, ['--cols' as string]: grid.cols } as CSSProperties}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        data-face={face}
        aria-label={`${face} face, ${grid.rows} rows by ${grid.cols} columns`}
      >
        {groups.map((g, i) =>
          g.face !== face ? null : (
            <button
              key={i}
              type="button"
              className={`face-group${selected === i ? ' selected' : ''}`}
              style={{ gridRow: `${g.grid_row + 1} / span ${g.rows}`, gridColumn: `${g.grid_col + 1} / span ${g.cols}`, borderColor: COLORS[i % COLORS.length], background: `${COLORS[i % COLORS.length]}22` }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onSelect(i)}
              aria-label={`Port group ${i + 1}${g.prefix ? ` (${g.prefix})` : ''}`}
            />
          ),
        )}
        {ports
          .filter((p) => p.face === face)
          .map((p) => (
            <span key={p.index} className="face-port" style={{ gridRow: p.row + 1, gridColumn: p.col + 1 }} data-code={p.code}>
              {p.code}
            </span>
          ))}
        {drag && (
          <span
            className="face-drawing"
            style={{ gridRow: `${Math.min(drag.r0, drag.r1) + 1} / span ${Math.abs(drag.r1 - drag.r0) + 1}`, gridColumn: `${Math.min(drag.c0, drag.c1) + 1} / span ${Math.abs(drag.c1 - drag.c0) + 1}` }}
          />
        )}
      </div>
    </div>
  );
}

function GroupPanel({ group, index, editable, onChange, onDelete, onClose }: { group: PortGroup; index: number; editable: boolean; onChange: (p: Partial<PortGroup>) => void; onDelete: () => void; onClose: () => void }) {
  const media = useMedia();
  const conn = media?.connectors.find((c) => c.name === group.connector);
  const n = (k: keyof PortGroup) => (e: { target: { value: string } }) => onChange({ [k]: num(e.target.value) });
  return (
    <Card title={`Port group ${index + 1}`} actions={<Button variant="ghost" onClick={onClose}>Done</Button>}>
      <fieldset disabled={!editable} className="plain">
        <div className="grid-2">
          <TextField label="Name prefix" maxLength={4} placeholder="e.g. G or SFP" value={group.prefix} onChange={(e) => onChange({ prefix: e.target.value })} />
          <TextField label="First number" type="number" min={0} value={group.start ?? ''} onChange={n('start')} hint="Blank to continue the prefix's sequence" />
          <SelectField
            label="Numbering"
            value={group.numbering ?? 'column_major'}
            onChange={(e) => onChange({ numbering: e.target.value as PortGroup['numbering'] })}
            options={[
              { value: 'column_major', label: 'Down then across (1 above 2)' },
              { value: 'row_major', label: 'Across then down' },
            ]}
          />
          <SelectField
            label="Role"
            value={group.role ?? ''}
            onChange={(e) => onChange({ role: (e.target.value || null) as PortGroup['role'] })}
            options={[
              { value: '', label: 'Usual for the type' },
              { value: 'active', label: 'Active' },
              { value: 'passive', label: 'Passive' },
            ]}
          />
          <SelectField
            label="Connector"
            value={group.connector ?? ''}
            onChange={(e) => onChange({ connector: e.target.value || null, transceiver: null })}
            options={[{ value: '', label: 'Usual for the type' }, ...(media?.connectors.map((c) => ({ value: c.name, label: c.name })) ?? [])]}
          />
          {conn?.cage && (
            <SelectField
              label="Module"
              value={group.transceiver ?? ''}
              onChange={(e) => onChange({ transceiver: e.target.value || null })}
              options={[{ value: '', label: 'Empty cage' }, ...(media?.transceivers.filter((t) => t.cage === group.connector).map((t) => ({ value: t.name, label: t.name })) ?? [])]}
            />
          )}
          <TextField label="Speed (Mb/s)" type="number" min={1} value={group.speed ?? ''} onChange={n('speed')} />
          <SelectField
            label="PoE"
            value={group.poe ?? ''}
            onChange={(e) => onChange({ poe: e.target.value || null })}
            options={[{ value: '', label: 'None' }, { value: 'af', label: '802.3af' }, { value: 'at', label: '802.3at' }, { value: 'bt', label: '802.3bt' }, { value: 'passive', label: 'Passive' }]}
          />
          {conn?.media.includes('power') && <TextField label="Outlet bank" type="number" min={1} value={group.outlet_group ?? ''} onChange={n('outlet_group')} />}
          <TextField label="Description" value={group.description ?? ''} onChange={(e) => onChange({ description: e.target.value || null })} />
        </div>
        <h4 className="form-section">Position</h4>
        <div className="grid-3">
          <SelectField label="Face" value={group.face} onChange={(e) => onChange({ face: e.target.value as Face })} options={[{ value: 'front', label: 'Front' }, { value: 'rear', label: 'Rear' }]} />
          <TextField label="Row" type="number" min={0} value={group.grid_row} onChange={n('grid_row')} />
          <TextField label="Column" type="number" min={0} value={group.grid_col} onChange={n('grid_col')} />
          <TextField label="Rows" type="number" min={1} value={group.rows} onChange={n('rows')} />
          <TextField label="Columns" type="number" min={1} value={group.cols} onChange={n('cols')} />
        </div>
        {editable && (
          <Button variant="danger" icon={<Trash2 size={15} />} onClick={onDelete}>Remove group</Button>
        )}
      </fieldset>
    </Card>
  );
}

function SaveImpact({ name, impacts, confirm, onClose, onSave }: { name: string; impacts: TemplateImpact[]; confirm: boolean; onClose: () => void; onSave: (confirmName?: string) => void }) {
  const [typed, setTyped] = useState('');
  const list = (label: string, xs: string[]) => (xs.length ? <div className="small"><strong>{label}:</strong> {xs.join(', ')}</div> : null);
  return (
    <Modal
      title={`Save changes to ${impacts.length} device(s)?`}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={confirm ? 'danger' : 'primary'} disabled={confirm && typed.trim() !== name} onClick={() => onSave(confirm ? typed.trim() : undefined)}>
            Save and update devices
          </Button>
        </>
      }
    >
      <p>Devices made from this template change with it. This is what happens:</p>
      <ul className="list impact-list">
        {impacts.map((i) => (
          <li key={i.device_id}>
            <strong className="mono">{i.path.split('/').slice(1).join(' / ')}</strong>
            {i.unplaced && <Badge tone="danger">moves to Unplaced (no longer fits)</Badge>}
            {list('Ports added', i.ports_added)}
            {list('Ports changed', i.ports_changed)}
            {list('Ports removed', i.ports_removed)}
            {list('Cables removed', i.cables_removed)}
          </li>
        ))}
      </ul>
      {confirm && <TextField label={`Ports, cables or placements are removed. Type ${name} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
    </Modal>
  );
}

function DeleteTemplate({ t, onDone }: { t: Template; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setOpen(true)}>Delete</Button>
      {open && (
        <FormModal
          title={`Delete ${t.name}`}
          submitLabel="Delete"
          danger
          onClose={() => setOpen(false)}
          onSubmit={async () => {
            await api.del(`/api/templates/${t.id}`);
            onDone();
          }}
        >
          <p>{t.device_count ? `Its ${t.device_count} device(s) keep their ports, as ordinary ports.` : 'No devices use it.'}</p>
        </FormModal>
      )}
    </>
  );
}
