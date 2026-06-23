import React, { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Plus,
  X,
  MapPin,
  DoorOpen,
} from 'lucide-react';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import './Locations.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyLocation() {
  return { name: '', building_number: '', notes: '' };
}

function emptyRoom() {
  return {
    name: '',
    floor: '',
    room_number: '',
    notes: '',
    contact_name: '',
    contact_phone: '',
    contact_email: '',
  };
}

// ---------------------------------------------------------------------------
// Modal: Add / Edit Location
// ---------------------------------------------------------------------------

function LocationModal({ initial, onSave, onClose }) {
  const [form, setForm] = useState(initial || emptyLocation());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) handleSave();
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="locations-overlay" onClick={onClose}>
      <div
        className="locations-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="locations-modal-header">
          <span className="locations-modal-title">
            {initial ? 'Edit Location' : 'Add Location'}
          </span>
          <button
            type="button"
            className="locations-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {error && <div className="locations-modal-error">{error}</div>}

        <div className="locations-form-field">
          <label className="locations-form-label">
            Name <span className="locations-form-required">*</span>
          </label>
          <input
            className="locations-form-input"
            value={form.name}
            onChange={set('name')}
            placeholder="Main Data Center"
            autoFocus
          />
        </div>

        <div className="locations-form-field">
          <label className="locations-form-label">Building Number</label>
          <input
            className="locations-form-input"
            value={form.building_number}
            onChange={set('building_number')}
            placeholder="Bldg 4"
          />
        </div>

        <div className="locations-form-field">
          <label className="locations-form-label">Notes</label>
          <textarea
            className="locations-form-textarea"
            value={form.notes}
            onChange={set('notes')}
            placeholder="Optional notes about this location…"
            rows={3}
          />
        </div>

        <div className="locations-modal-footer">
          <button
            type="button"
            className="locations-modal-cancel"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="locations-modal-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal: Add / Edit Room
// ---------------------------------------------------------------------------

function RoomModal({ initial, onSave, onClose }) {
  const [form, setForm] = useState(initial || emptyRoom());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="locations-overlay" onClick={onClose}>
      <div
        className="locations-modal locations-modal-wide"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="locations-modal-header">
          <span className="locations-modal-title">
            {initial ? 'Edit Room' : 'Add Room'}
          </span>
          <button
            type="button"
            className="locations-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {error && <div className="locations-modal-error">{error}</div>}

        <div className="locations-form-row">
          <div className="locations-form-field locations-form-field-grow">
            <label className="locations-form-label">
              Name <span className="locations-form-required">*</span>
            </label>
            <input
              className="locations-form-input"
              value={form.name}
              onChange={set('name')}
              placeholder="Server Room A"
              autoFocus
            />
          </div>
        </div>

        <div className="locations-form-row">
          <div className="locations-form-field">
            <label className="locations-form-label">Floor</label>
            <input
              className="locations-form-input"
              value={form.floor}
              onChange={set('floor')}
              placeholder="1"
            />
          </div>
          <div className="locations-form-field">
            <label className="locations-form-label">Room Number</label>
            <input
              className="locations-form-input"
              value={form.room_number}
              onChange={set('room_number')}
              placeholder="101"
            />
          </div>
        </div>

        <div className="locations-form-field">
          <label className="locations-form-label">Notes</label>
          <textarea
            className="locations-form-textarea"
            value={form.notes}
            onChange={set('notes')}
            placeholder="Optional notes…"
            rows={2}
          />
        </div>

        <div className="locations-form-row">
          <div className="locations-form-field locations-form-field-grow">
            <label className="locations-form-label">Contact Name</label>
            <input
              className="locations-form-input"
              value={form.contact_name}
              onChange={set('contact_name')}
              placeholder="Jane Smith"
            />
          </div>
          <div className="locations-form-field">
            <label className="locations-form-label">Contact Phone</label>
            <input
              className="locations-form-input"
              value={form.contact_phone}
              onChange={set('contact_phone')}
              placeholder="+1 555 000 0000"
            />
          </div>
        </div>

        <div className="locations-form-field">
          <label className="locations-form-label">Contact Email</label>
          <input
            className="locations-form-input"
            type="email"
            value={form.contact_email}
            onChange={set('contact_email')}
            placeholder="jane@example.com"
          />
        </div>

        <div className="locations-modal-footer">
          <button
            type="button"
            className="locations-modal-cancel"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="locations-modal-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room list (inside an expanded location card)
// ---------------------------------------------------------------------------

function RoomList({ locationId, onRoomCountChange }) {
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [roomModal, setRoomModal] = useState(null); // null | { mode: 'add' } | { mode: 'edit', room }
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const loadRooms = useCallback(() => {
    setLoading(true);
    client
      .get(`/locations/${locationId}/rooms`)
      .then((res) => {
        const data = res.data || [];
        setRooms(data);
        onRoomCountChange?.(data.length);
      })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [locationId, onRoomCountChange]);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const handleAddRoom = async (form) => {
    await client.post(`/locations/${locationId}/rooms`, form);
    loadRooms();
  };

  const handleEditRoom = async (form) => {
    await client.put(`/rooms/${roomModal.room.id}`, form);
    loadRooms();
  };

  const handleDeleteRoom = async (id) => {
    try {
      await client.delete(`/rooms/${id}`);
      loadRooms();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
    setConfirmDeleteId(null);
  };

  return (
    <div className="locations-rooms-section">
      <div className="locations-rooms-header">
        <span className="locations-rooms-title">
          <DoorOpen size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          Rooms
        </span>
        <button
          type="button"
          className="locations-btn locations-btn-accent locations-add-room-btn"
          onClick={() => setRoomModal({ mode: 'add' })}
        >
          <Plus size={13} />
          Add Room
        </button>
      </div>

      {error && <div className="locations-room-error">{error}</div>}

      {loading ? (
        <div className="locations-room-loading">Loading rooms…</div>
      ) : rooms.length === 0 ? (
        <div className="locations-rooms-empty">No rooms yet.</div>
      ) : (
        <ul className="locations-room-list">
          {rooms.map((room) => (
            <li key={room.id} className="locations-room-item">
              <div className="locations-room-info">
                <span className="locations-room-name">{room.name}</span>
                <div className="locations-room-meta">
                  {room.floor && <span>Floor {room.floor}</span>}
                  {room.room_number && <span>Room {room.room_number}</span>}
                  {room.rack_count != null && (
                    <span>{room.rack_count} rack{room.rack_count !== 1 ? 's' : ''}</span>
                  )}
                  {room.contact_name && <span>{room.contact_name}</span>}
                </div>
              </div>
              <div className="locations-room-actions">
                {confirmDeleteId === room.id ? (
                  <>
                    <span className="locations-confirm-text">Delete?</span>
                    <button
                      type="button"
                      className="locations-btn locations-btn-danger"
                      onClick={() => handleDeleteRoom(room.id)}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      className="locations-btn"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      No
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="locations-btn"
                      onClick={() => setRoomModal({ mode: 'edit', room })}
                      title="Edit room"
                    >
                      <Pencil size={12} />
                      Edit
                    </button>
                    <button
                      type="button"
                      className="locations-btn locations-btn-danger"
                      onClick={() => setConfirmDeleteId(room.id)}
                      title="Delete room"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {roomModal?.mode === 'add' && (
        <RoomModal onSave={handleAddRoom} onClose={() => setRoomModal(null)} />
      )}
      {roomModal?.mode === 'edit' && (
        <RoomModal
          initial={{
            name: roomModal.room.name || '',
            floor: roomModal.room.floor || '',
            room_number: roomModal.room.room_number || '',
            notes: roomModal.room.notes || '',
            contact_name: roomModal.room.contact_name || '',
            contact_phone: roomModal.room.contact_phone || '',
            contact_email: roomModal.room.contact_email || '',
          }}
          onSave={handleEditRoom}
          onClose={() => setRoomModal(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Location Card
// ---------------------------------------------------------------------------

function LocationCard({ location, onEdit, onDelete, onRoomCountChange }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [roomCount, setRoomCount] = useState(location.room_count ?? 0);

  const handleRoomCountChange = useCallback(
    (count) => {
      setRoomCount(count);
      onRoomCountChange?.(location.id, count);
    },
    [location.id, onRoomCountChange]
  );

  return (
    <div className="locations-card">
      <div className="locations-card-main">
        <div className="locations-card-name-row">
          <MapPin size={15} className="locations-card-pin-icon" />
          <span className="locations-card-name">{location.name}</span>
        </div>
        {location.building_number && (
          <div className="locations-card-building">Bldg {location.building_number}</div>
        )}
        {location.notes && (
          <div className="locations-card-notes">{location.notes}</div>
        )}

        <div className="locations-card-badges">
          <span className="locations-badge">
            {roomCount} room{roomCount !== 1 ? 's' : ''}
          </span>
          {location.rack_count != null && (
            <span className="locations-badge">
              {location.rack_count} rack{location.rack_count !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="locations-card-actions">
          <button
            type="button"
            className="locations-btn"
            onClick={() => onEdit(location)}
            title="Edit location"
          >
            <Pencil size={13} />
            Edit
          </button>

          {confirmDelete ? (
            <>
              <span className="locations-confirm-text">Delete?</span>
              <button
                type="button"
                className="locations-btn locations-btn-danger"
                onClick={() => onDelete(location.id)}
              >
                Yes
              </button>
              <button
                type="button"
                className="locations-btn"
                onClick={() => setConfirmDelete(false)}
              >
                No
              </button>
            </>
          ) : (
            <button
              type="button"
              className="locations-btn locations-btn-danger"
              onClick={() => setConfirmDelete(true)}
              title="Delete location"
            >
              <Trash2 size={13} />
              Delete
            </button>
          )}

          <button
            type="button"
            className={`locations-btn locations-btn-accent locations-manage-rooms-btn${expanded ? ' locations-btn-expanded' : ''}`}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Hide rooms' : 'Manage rooms'}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Manage Rooms
          </button>
        </div>
      </div>

      {expanded && (
        <RoomList
          locationId={location.id}
          onRoomCountChange={handleRoomCountChange}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function LocationsPage() {
  const { currentProjectId } = useProject();
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [locationModal, setLocationModal] = useState(null); // null | { mode: 'add' } | { mode: 'edit', location }

  const loadLocations = useCallback(() => {
    if (!currentProjectId) return;
    setLoading(true);
    setError(null);
    client
      .get(`/projects/${currentProjectId}/locations`)
      .then((res) => setLocations(res.data || []))
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [currentProjectId]);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  const handleAddLocation = async (form) => {
    await client.post(`/projects/${currentProjectId}/locations`, form);
    loadLocations();
  };

  const handleEditLocation = async (form) => {
    await client.put(`/locations/${locationModal.location.id}`, form);
    loadLocations();
  };

  const handleDeleteLocation = async (id) => {
    try {
      await client.delete(`/locations/${id}`);
      setLocations((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleRoomCountChange = useCallback((locationId, count) => {
    setLocations((prev) =>
      prev.map((l) => (l.id === locationId ? { ...l, room_count: count } : l))
    );
  }, []);

  return (
    <div className="locations-page">
      <div className="locations-header">
        <h2>
          <Building2 size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} />
          Locations
        </h2>
        <button
          type="button"
          className="locations-add-btn"
          onClick={() => setLocationModal({ mode: 'add' })}
        >
          <Plus size={15} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          Add Location
        </button>
      </div>

      {error && <div className="page-error">{error}</div>}

      {loading ? (
        <div className="page-status">Loading locations…</div>
      ) : locations.length === 0 ? (
        <div className="locations-empty">
          <MapPin size={32} className="locations-empty-icon" />
          <p>No locations yet.</p>
          <p>Click <strong>Add Location</strong> to create your first site.</p>
        </div>
      ) : (
        <div className="locations-grid">
          {locations.map((location) => (
            <LocationCard
              key={location.id}
              location={location}
              onEdit={(loc) => setLocationModal({ mode: 'edit', location: loc })}
              onDelete={handleDeleteLocation}
              onRoomCountChange={handleRoomCountChange}
            />
          ))}
        </div>
      )}

      {locationModal?.mode === 'add' && (
        <LocationModal
          onSave={handleAddLocation}
          onClose={() => setLocationModal(null)}
        />
      )}
      {locationModal?.mode === 'edit' && (
        <LocationModal
          initial={{
            name: locationModal.location.name || '',
            building_number: locationModal.location.building_number || '',
            notes: locationModal.location.notes || '',
          }}
          onSave={handleEditLocation}
          onClose={() => setLocationModal(null)}
        />
      )}
    </div>
  );
}
