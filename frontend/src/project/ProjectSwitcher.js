import React, { useEffect, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useProject, DEFAULT_PROJECT_ID } from './ProjectContext';
import client from '../api/client';
import TemplatePicker from '../components/TemplatePicker';
import './ProjectSwitcher.css';

const DELETE_WARNING =
  'This will permanently delete all devices, scans, topology, and racks in this project. This cannot be undone.';

export default function ProjectSwitcher() {
  const {
    projects,
    currentProject,
    switchProject,
    createProject,
    updateProject,
    deleteProject,
  } = useProject();

  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(null); // null | { mode: 'create' | 'edit', project }
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [createStep, setCreateStep] = useState('details'); // 'details' | 'template'
  const [template, setTemplate] = useState('blank');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Close the dropdown when clicking outside it.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const openCreate = () => {
    setOpen(false);
    setModal({ mode: 'create', project: null });
    setName('');
    setDescription('');
    setCreateStep('details');
    setTemplate('blank');
    setError(null);
  };

  const openEdit = (project) => {
    setOpen(false);
    setModal({ mode: 'edit', project });
    setName(project.name || '');
    setDescription(project.description || '');
    setError(null);
  };

  const closeModal = () => {
    setModal(null);
    setError(null);
    setSaving(false);
  };

  // Switching projects updates context immediately. If we're on a route that
  // pins a project id into the URL (the dashboard), the URL must move with
  // it — otherwise the Dashboard's own URL-sync effect sees the stale id on
  // remount and switches straight back to the old project.
  const handleSwitch = (project) => {
    switchProject(project.id);
    if (matchPath('/projects/:id', location.pathname)) {
      navigate(`/projects/${project.id}`);
    }
    setOpen(false);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (modal.mode === 'create' && createStep === 'details') {
      setError(null);
      setCreateStep('template');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (modal.mode === 'create') {
        await createAndApplyTemplate(template);
      } else {
        await updateProject(modal.project.id, {
          name: name.trim(),
          description: description.trim() || null,
        });
        closeModal();
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  const createAndApplyTemplate = async (templateKey) => {
    const project = await createProject({ name: name.trim(), description: description.trim() || null });
    if (templateKey !== 'blank') {
      await client.post(`/projects/${project.id}/apply-template`, { template: templateKey });
    }
    closeModal();
    navigate(`/projects/${project.id}`);
  };

  const handleCreateBack = () => {
    setCreateStep('details');
    setError(null);
  };

  const handleStartBlank = async () => {
    setSaving(true);
    setError(null);
    try {
      await createAndApplyTemplate('blank');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!modal?.project) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(DELETE_WARNING)) return;
    setSaving(true);
    setError(null);
    try {
      await deleteProject(modal.project.id);
      closeModal();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  return (
    <div className="project-switcher" ref={containerRef}>
      <button
        type="button"
        className="project-switcher-button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="project-switcher-label">{currentProject?.name || 'Select project'}</span>
        <span className={`project-switcher-chevron${open ? ' open' : ''}`}>▾</span>
      </button>

      {open && (
        <div className="project-switcher-menu" role="listbox">
          <div className="project-switcher-list">
            {projects.map((project) => (
              <div
                key={project.id}
                className={`project-switcher-item${
                  project.id === currentProject?.id ? ' active' : ''
                }`}
              >
                <button
                  type="button"
                  className="project-switcher-item-name"
                  onClick={() => handleSwitch(project)}
                >
                  {project.name}
                </button>
                <button
                  type="button"
                  className="project-switcher-item-settings"
                  title="Project settings"
                  aria-label={`Settings for ${project.name}`}
                  onClick={() => openEdit(project)}
                >
                  ⚙
                </button>
              </div>
            ))}
            {projects.length === 0 && (
              <div className="project-switcher-empty">No projects</div>
            )}
          </div>
          <button type="button" className="project-switcher-new" onClick={openCreate}>
            + New Project
          </button>
        </div>
      )}

      {modal && (
        <div className="project-modal-overlay" onMouseDown={closeModal}>
          <div
            className={`project-modal${modal.mode === 'create' && createStep === 'template' ? ' project-modal-wide' : ''}`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3>
              {modal.mode === 'edit'
                ? 'Project Settings'
                : createStep === 'template'
                ? 'Choose a starting template'
                : 'New Project'}
            </h3>
            <form onSubmit={handleSave}>
              {modal.mode === 'create' && createStep === 'template' ? (
                <div className="project-modal-template-step">
                  <TemplatePicker value={template} onChange={setTemplate} />
                </div>
              ) : (
                <>
                  <label>
                    Name
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Project name"
                      autoFocus
                    />
                  </label>
                  <label>
                    Description (optional)
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What is this project for?"
                      rows={3}
                    />
                  </label>
                </>
              )}

              {error && <div className="project-modal-error">{error}</div>}

              <div className="project-modal-actions">
                {modal.mode === 'edit' && modal.project.id !== DEFAULT_PROJECT_ID && (
                  <button
                    type="button"
                    className="project-modal-delete"
                    onClick={handleDelete}
                    disabled={saving}
                  >
                    Delete Project
                  </button>
                )}
                {modal.mode === 'create' && createStep === 'template' && (
                  <button type="button" onClick={handleCreateBack} disabled={saving}>
                    Back
                  </button>
                )}
                <div className="project-modal-actions-right">
                  {modal.mode === 'create' && createStep === 'template' && (
                    <button type="button" className="project-modal-link" onClick={handleStartBlank} disabled={saving}>
                      Start blank
                    </button>
                  )}
                  <button type="button" onClick={closeModal} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="project-modal-save" disabled={saving}>
                    {saving
                      ? 'Saving...'
                      : modal.mode === 'edit'
                      ? 'Save'
                      : createStep === 'details'
                      ? 'Continue'
                      : 'Create Project'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
