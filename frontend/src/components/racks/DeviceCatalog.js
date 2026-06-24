import React, { useState } from 'react';
import { X, ChevronDown, ChevronRight, GripVertical, Trash2 } from 'lucide-react';
import { RACK_CATALOG, CATALOG_CATEGORIES, groupByCategory, findCatalogEntryByModel } from './rackCatalog';
import { normalizeCatalogEntry } from './deviceFieldSchemas';
import { getCategoryStyle } from './deviceRenderConfig';
import { normalizeSlotWidth, resolveFractionalPlacement, resolveVerticalPduSide } from './rackPlacement';
import './DeviceCatalog.css';

// click-to-place finds a U row by scanning rather than dropping on a
// specific one, so there's no single "exact target row" the way
// RackCanvas's drag-and-drop has — for a fractional-width device, this
// just prefers the first row (top down) that can take it, whether that's
// an existing compatible group with an open column or a fresh empty row.
function findNextFreeU(rack, allSlots, uSize, mountedFace, slotWidth) {
  const width = normalizeSlotWidth(slotWidth);
  const targetFace = mountedFace === 'rear' ? 'rear' : 'front';

  if (width !== 'full') {
    for (let u = 1; u <= rack.u_height; u++) {
      const resolved = resolveFractionalPlacement({
        slots: allSlots, rackId: rack.id, face: targetFace, uPosition: u, slotWidth: width,
      });
      if (resolved.ok) return { u_position: u, slot_position: resolved.slot_position };
    }
    return null;
  }

  const occupied = new Set();
  for (const s of allSlots) {
    if (s.rack_id !== rack.id) continue;
    // Vertical PDUs are 0U floating elements, not real U-grid occupants —
    // their stored u_position/u_size must never block where a new device
    // from the catalog can land.
    if (s.item_type === 'vertical-pdu') continue;
    const face = s.mounted_face || s.front_back || 'front';
    if (face !== 'both' && face !== targetFace) continue;
    for (let u = s.u_position; u <= s.u_position + s.u_size - 1; u++) occupied.add(u);
  }
  for (let start = 1; start + uSize - 1 <= rack.u_height; start++) {
    let free = true;
    for (let u = start; u <= start + uSize - 1; u++) {
      if (occupied.has(u)) { free = false; break; }
    }
    if (free) return { u_position: start, slot_position: 0 };
  }
  return null;
}

function buildBadges(normalized, floating) {
  // Floating (0U) entries mount to a side rail channel, not a U row — "0U"
  // reads as confusing/broken rather than informative, so show "Rail" instead.
  const badges = [floating ? 'Rail' : `${normalized.u_size}U`];
  if (normalized.port_count) badges.push(`${normalized.port_count}-port`);
  if (normalized.bay_count) badges.push(`${normalized.bay_count}-bay`);
  if (normalized.capacity_va) badges.push(`${normalized.capacity_va}VA`);
  if (normalized.input_voltage) badges.push(normalized.input_voltage);
  const groups = normalized.outlet_groups || [];
  if (groups.length === 1 && groups[0].count) {
    badges.push(`${groups[0].count}x ${groups[0].type || 'outlet'}`);
  } else if (groups.length > 1) {
    badges.push(`${groups.reduce((sum, g) => sum + (Number(g.count) || 0), 0)} outlets`);
  }
  return badges;
}

function CatalogCard({ entry, source, onClick, onDragStart, onContextMenu, renaming, onRenameSubmit, onRenameCancel, onDelete }) {
  const normalized = normalizeCatalogEntry(entry, source);
  const { color, Icon } = getCategoryStyle({ custom_type: normalized.render_type });
  const iconBoxStyle = { borderColor: `${color}55`, background: `${color}18` };
  const badges = buildBadges(normalized, entry.floating);
  const [renameValue, setRenameValue] = useState(entry.name);

  return (
    <div
      className="dc-card"
      draggable
      onDragStart={onDragStart}
      onClick={renaming ? undefined : onClick}
      onContextMenu={onContextMenu}
      title={`${entry.name} · ${normalized.u_size}U${normalized.mounted_face === 'rear' ? ' · Rear' : ''}`}
    >
      <GripVertical size={12} className="dc-card-grip" />
      <div className="dc-card-icon-box" style={iconBoxStyle}>
        <Icon size={13} color={color} />
      </div>
      {renaming ? (
        <input
          className="dc-card-rename-input"
          autoFocus
          value={renameValue}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameSubmit(renameValue);
            if (e.key === 'Escape') onRenameCancel();
          }}
          onBlur={() => onRenameSubmit(renameValue)}
        />
      ) : (
        <span className="dc-card-name">{entry.name}</span>
      )}
      <div className="dc-card-badges">
        {badges.map((b) => <span key={b} className="dc-card-badge">{b}</span>)}
        {normalized.slot_width === 'half-width' && <span className="dc-card-badge dc-card-badge-accent">½W</span>}
        {normalized.slot_width === 'third' && <span className="dc-card-badge dc-card-badge-accent">⅓W</span>}
        {normalized.half_depth && <span className="dc-card-badge dc-card-badge-accent">½D</span>}
        {normalized.mounted_face === 'rear' && <span className="dc-card-badge dc-card-badge-rear">Rear</span>}
      </div>
      {onDelete && (
        <button
          type="button"
          className="dc-card-delete"
          title="Delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

function CollapsibleGroup({ title, count, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen !== false);
  return (
    <div className="dc-group">
      <button type="button" className="dc-group-header" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
        <span className="dc-group-count">{count}</span>
      </button>
      {open && <div className="dc-group-body">{children}</div>}
    </div>
  );
}

const TAB_DEFS = [
  { id: 'category',  label: 'Category' },
  { id: 'az',        label: 'A–Z' },
  { id: 'custom',    label: 'Custom' },
];

export default function DeviceCatalog({
  open,
  onClose,
  racks,
  allSlots,
  devices,
  userCatalogEntries,
  focusedRackId,
  actions,
  onRequestPlacement,
  onCustomEntryRenamed,
  onCustomEntryDeleted,
}) {
  const [tab, setTab] = useState('category');
  const [search, setSearch] = useState('');
  const [unrackedOpen, setUnrackedOpen] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [customCtxMenu, setCustomCtxMenu] = useState(null); // { id, x, y }

  if (!open) return null;

  const focusedRack = racks.find((r) => r.id === focusedRackId) || null;
  const rackedDeviceIds = new Set(allSlots.map((s) => s.device_id).filter(Boolean));
  const unrackedDevices = devices.filter((d) => !rackedDeviceIds.has(d.id));

  // Floating (0U) entries (vertical PDUs) ARE placeable from here now — they
  // just don't go into a U row, they go into a side rail channel (see
  // requestVerticalPduPlacement / RackCanvas's handleDropChannel) instead of
  // findNextFreeU's U-grid scan.
  const placeableCatalog = RACK_CATALOG;

  const searchTerm = search.trim().toLowerCase();
  const filteredCatalog = searchTerm
    ? placeableCatalog.filter((e) => e.name.toLowerCase().includes(searchTerm))
    : placeableCatalog;
  const placeableCustomEntries = userCatalogEntries.filter((c) => c.render_type !== 'pdu-vertical');
  const filteredCustomEntries = searchTerm
    ? placeableCustomEntries.filter((c) => c.name.toLowerCase().includes(searchTerm))
    : placeableCustomEntries;

  const requestCatalogPlacement = (entry) => {
    if (!focusedRack) return;
    const mounted_face = entry.mountedFace || 'front';
    const found = findNextFreeU(focusedRack, allSlots, entry.uSize, mounted_face, entry.slotWidth);
    if (!found) return;
    onRequestPlacement({ source: 'catalog', entry, target: { rack_id: focusedRack.id, u_position: found.u_position, mounted_face } });
  };

  // Vertical PDUs skip the quick-config modal entirely (its width/depth/
  // U-size fields don't apply to a 0U floating strip) and create directly,
  // same as addUnrackedDevice below — auto-picking whichever side rail
  // channel has fewer PDUs (left-preferred on a tie), same fallback
  // RackCanvas's handleDropChannel and the legacy UPS-side "Add Vertical
  // PDU" flow both use when no specific side was dragged to.
  const placeVerticalPdu = (entry) => {
    if (!focusedRack) return;
    const resolved = resolveVerticalPduSide({
      verticalPdus: allSlots.filter((s) => s.item_type === 'vertical-pdu' && s.rack_id === focusedRack.id),
      side: undefined,
    });
    if (!resolved.ok) {
      actions.onPlacementRejected?.(resolved.error);
      return;
    }
    const u_size = Math.max(1, Math.round(focusedRack.u_height * 0.5));
    const u_position = focusedRack.u_height - u_size + 1;
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      item_type: 'vertical-pdu',
      item_label: entry.name,
      catalog_id: entry.id,
      custom_type: entry.renderType,
      u_position,
      u_size,
      mount_side: resolved.side,
      outlet_groups: entry.outletCount ? [{ type: entry.outletType || 'Other', count: entry.outletCount }] : [],
      input_voltage: entry.inputVoltage || null,
    });
  };

  // Shared click/drag wiring for a non-custom catalog entry — vertical
  // PDUs (floating: true) go to the side-rail path with their own
  // dataTransfer key (read by RackEnclosure's PduChannel / RackCanvas's
  // handleDropChannel), everything else keeps the normal U-row path.
  const catalogCardHandlers = (entry) => ({
    onClick: () => (entry.floating ? placeVerticalPdu(entry) : requestCatalogPlacement(entry)),
    onDragStart: (e) => e.dataTransfer.setData(
      entry.floating ? 'text/vertical-pdu-item' : 'text/catalog-item',
      JSON.stringify(entry)
    ),
  });

  const requestCustomPlacement = (custom) => {
    if (!focusedRack) return;
    const mounted_face = custom.mounted_face || 'front';
    const found = findNextFreeU(focusedRack, allSlots, custom.u_size, mounted_face);
    if (!found) return;
    onRequestPlacement({ source: 'custom', entry: custom, target: { rack_id: focusedRack.id, u_position: found.u_position, mounted_face } });
  };

  const addUnrackedDevice = (device) => {
    if (!focusedRack) return;
    const catalogMatch = findCatalogEntryByModel(device.model);
    const uSize = catalogMatch ? catalogMatch.uSize : 1;
    const mountedFace = catalogMatch ? catalogMatch.mountedFace : 'front';
    const found = findNextFreeU(focusedRack, allSlots, uSize, mountedFace, catalogMatch?.slotWidth);
    if (!found) return;
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      device_id: device.id,
      item_type: 'device',
      u_position: found.u_position,
      u_size: uSize,
      mounted_face: mountedFace,
      half_depth: catalogMatch?.halfDepth ? 1 : 0,
      slot_width: catalogMatch?.slotWidth || 'full',
      slot_position: found.slot_position,
    });
  };

  const renderCategoryTab = () => {
    const byCategory = groupByCategory(filteredCatalog);
    return CATALOG_CATEGORIES.filter((c) => byCategory.has(c.id)).map((cat) => {
      const entries = byCategory.get(cat.id);
      return (
        <CollapsibleGroup key={cat.id} title={cat.label} count={entries.length}>
          {entries.map((entry) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              source="catalog"
              {...catalogCardHandlers(entry)}
            />
          ))}
        </CollapsibleGroup>
      );
    });
  };

  const renderAZTab = () => {
    const sorted = [...filteredCatalog].sort((a, b) => a.name.localeCompare(b.name));
    const byLetter = new Map();
    for (const entry of sorted) {
      const letter = entry.name[0].toUpperCase();
      if (!byLetter.has(letter)) byLetter.set(letter, []);
      byLetter.get(letter).push(entry);
    }
    return Array.from(byLetter.entries()).map(([letter, entries]) => (
      <CollapsibleGroup key={letter} title={letter} count={entries.length}>
        {entries.map((entry) => (
          <CatalogCard
            key={entry.id}
            entry={entry}
            source="catalog"
            {...catalogCardHandlers(entry)}
          />
        ))}
      </CollapsibleGroup>
    ));
  };

  const submitRename = (custom, newName) => {
    setRenamingId(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === custom.name) return;
    onCustomEntryRenamed(custom.id, trimmed);
  };

  const renderCustomTab = () => (
    <div className="dc-custom-section">
      {filteredCustomEntries.map((custom) => (
        <CatalogCard
          key={custom.id}
          entry={custom}
          source="custom"
          onClick={() => requestCustomPlacement(custom)}
          onDragStart={(e) => e.dataTransfer.setData('text/custom-device-id', String(custom.id))}
          onContextMenu={(e) => { e.preventDefault(); setCustomCtxMenu({ id: custom.id, x: e.clientX, y: e.clientY }); }}
          renaming={renamingId === custom.id}
          onRenameSubmit={(newName) => submitRename(custom, newName)}
          onRenameCancel={() => setRenamingId(null)}
          onDelete={() => onCustomEntryDeleted(custom.id)}
        />
      ))}
      {filteredCustomEntries.length === 0 && (
        <p className="dc-empty">
          No saved devices yet. Place a device, then use "Save to Catalog" in its properties panel.
        </p>
      )}
    </div>
  );

  return (
    <div className="device-catalog">
      <div className="dc-header">
        <span className="dc-title">Device Catalog</span>
        <button type="button" className="dc-close" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <p className="dc-hint">
        {focusedRack
          ? `Click to add to "${focusedRack.name}", or drag to any rack.`
          : 'Click a rack to enable click-to-add, or drag cards onto any rack.'}
      </p>

      <div className="dc-tabs">
        {TAB_DEFS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="dc-search-row">
        <input
          type="text"
          className="dc-search"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="dc-list">
        {tab !== 'custom' && (
          <div className="dc-group dc-group-unracked">
            <button type="button" className="dc-group-header" onClick={() => setUnrackedOpen((v) => !v)}>
              {unrackedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>Unracked Devices</span>
              <span className="dc-group-count">{unrackedDevices.length}</span>
            </button>
            {unrackedOpen && (
              unrackedDevices.length === 0 ? (
                <p className="dc-empty">No unracked devices.</p>
              ) : (
                <div className="dc-group-body">
                  {unrackedDevices.map((device) => {
                    const { color, Icon } = getCategoryStyle({ device_type: device.type, item_type: 'device' });
                    const iconBoxStyle = { borderColor: `${color}55`, background: `${color}18` };
                    const catalogMatch = findCatalogEntryByModel(device.model);
                    const uSize = catalogMatch ? catalogMatch.uSize : 1;
                    return (
                      <div
                        key={device.id}
                        className="dc-card"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/device-id', String(device.id));
                          if (catalogMatch) {
                            e.dataTransfer.setData('text/device-catalog', JSON.stringify({
                              uSize: catalogMatch.uSize,
                              mountedFace: catalogMatch.mountedFace,
                              halfDepth: catalogMatch.halfDepth,
                              slotWidth: catalogMatch.slotWidth,
                            }));
                          }
                        }}
                        onClick={() => addUnrackedDevice(device)}
                        title={`${device.hostname || device.ip || `Device ${device.id}`}${catalogMatch ? ` · ${uSize}U${catalogMatch.mountedFace === 'rear' ? ' · Rear' : ''}` : ''}`}
                      >
                        <GripVertical size={12} className="dc-card-grip" />
                        <div className="dc-card-icon-box" style={iconBoxStyle}>
                          <Icon size={13} color={color} />
                        </div>
                        <span className="dc-card-name">{device.hostname || device.ip || `Device ${device.id}`}</span>
                        <div className="dc-card-badges">
                          <span className="dc-card-badge">{uSize}U</span>
                          {catalogMatch?.mountedFace === 'rear' && <span className="dc-card-badge dc-card-badge-rear">Rear</span>}
                          {catalogMatch?.halfDepth && <span className="dc-card-badge dc-card-badge-accent">½D</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
        )}

        {tab === 'category' && renderCategoryTab()}
        {tab === 'az'       && <div className="dc-az-list">{renderAZTab()}</div>}
        {tab === 'custom'   && renderCustomTab()}
      </div>

      {customCtxMenu && (
        <div className="dc-ctx-menu-overlay" onMouseDown={() => setCustomCtxMenu(null)}>
          <div
            className="dc-ctx-menu"
            style={{ top: customCtxMenu.y, left: customCtxMenu.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => { setRenamingId(customCtxMenu.id); setCustomCtxMenu(null); }}
            >
              Rename
            </button>
            <button
              type="button"
              className="dc-ctx-menu-danger"
              onClick={() => { onCustomEntryDeleted(customCtxMenu.id); setCustomCtxMenu(null); }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
