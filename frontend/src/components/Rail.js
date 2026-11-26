import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Share2,
  Warehouse,
  Server,
  Network,
  MapPin,
  Blocks,
  Camera,
  DoorOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { useProject, DEFAULT_PROJECT_ID } from '../project/ProjectContext';
import ProjectSwitcher from '../project/ProjectSwitcher';
import client from '../api/client';
import './Rail.css';

// Routes whose whole job is a large canvas. The rail starts collapsed on
// these so the canvas gets the width back; the user can still expand it,
// and it re-collapses next time they come back to a canvas route.
const CANVAS_ROUTES = ['/topology', '/racks'];

// countKey names a field from GET /api/projects/:id/counts. Links without
// one show no badge — a count is only worth showing where it tells you
// whether the page has anything in it.
const GROUPS = [
  {
    items: [
      { to: '/dashboard', label: 'Overview', icon: LayoutDashboard, isOverview: true },
    ],
  },
  {
    title: 'Document',
    items: [
      { to: '/topology', label: 'Topology', icon: Share2 },
      { to: '/racks', label: 'Racks', icon: Warehouse, countKey: 'racks' },
      {
        to: '/devices',
        label: 'Devices',
        icon: Server,
        countKey: 'devices',
        children: [
          { to: '/devices', label: 'All devices', end: true },
          { to: '/devices/network', label: 'Network' },
          { to: '/devices/cameras', label: 'Cameras', icon: Camera, countKey: 'cameras' },
          { to: '/devices/access', label: 'Access', icon: DoorOpen, countKey: 'accessDevices' },
        ],
      },
      { to: '/vlans', label: 'VLANs', icon: Network, countKey: 'vlans' },
      { to: '/locations', label: 'Locations', icon: MapPin, countKey: 'locations' },
    ],
  },
  {
    title: 'Configure',
    items: [
      { to: '/integrations', label: 'Integrations', icon: Blocks, countKey: 'integrations' },
    ],
  },
];

// /devices/:id renders the Devices page, so it should keep "All devices" lit.
function isDeviceDetail(pathname) {
  return /^\/devices\/\d+$/.test(pathname);
}

export default function Rail() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { currentProjectId } = useProject();
  const location = useLocation();
  const { pathname } = location;

  const canvasRoute = CANVAS_ROUTES.some((route) => pathname.startsWith(route));
  // null means "follow the route"; a boolean is the user overriding it.
  const [override, setOverride] = useState(null);
  const collapsed = override === null ? canvasRoute : override;

  // Drop the override whenever we cross between canvas and non-canvas
  // routes, so the automatic behaviour resumes on the next canvas page.
  const lastCanvasRoute = useRef(canvasRoute);
  useEffect(() => {
    if (lastCanvasRoute.current !== canvasRoute) {
      lastCanvasRoute.current = canvasRoute;
      setOverride(null);
    }
  }, [canvasRoute]);

  const [counts, setCounts] = useState(null);
  const loadCounts = useCallback(() => {
    if (!currentProjectId) return undefined;
    let cancelled = false;
    client
      .get(`/projects/${currentProjectId}/counts`)
      .then((res) => {
        if (!cancelled) setCounts(res.data);
      })
      // Counts are decoration — a failure here must not disturb the page.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  // Refetch on navigation so a device you just added shows up in the badge.
  useEffect(() => loadCounts(), [loadCounts, pathname]);

  const overviewTo = `/projects/${currentProjectId ?? DEFAULT_PROJECT_ID}`;
  const devicesOpen = !collapsed && pathname.startsWith('/devices');

  const renderCount = (key) => {
    if (!key || !counts) return null;
    const value = counts[key];
    if (!value) return null;
    return <span className="rail-count">{value}</span>;
  };

  return (
    <nav className={`rail${collapsed ? ' rail-collapsed' : ''}`} aria-label="Main">
      <div className="rail-head">
        <Link to={overviewTo} className="rail-brand" title="Rackpath">
          {collapsed ? (
            <span className="rail-brand-mark" aria-hidden="true">
              R<em>p</em>
            </span>
          ) : (
            <span className="rail-brand-full">
              Rack<em>path</em>
            </span>
          )}
        </Link>
        {!collapsed && (
          <div className="rail-project">
            <ProjectSwitcher />
          </div>
        )}
      </div>

      <div className="rail-scroll">
        {GROUPS.map((group, groupIndex) => (
          <div className="rail-group" key={group.title || `group-${groupIndex}`}>
            {group.title &&
              (collapsed ? (
                <div className="rail-group-divider" role="presentation" />
              ) : (
                <div className="rail-group-title u-label">{group.title}</div>
              ))}
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <React.Fragment key={item.to}>
                  <NavLink
                    to={item.isOverview ? overviewTo : item.to}
                    end={item.to === '/devices'}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) => {
                      const active =
                        isActive ||
                        (item.to === '/devices' && isDeviceDetail(pathname)) ||
                        (item.isOverview && pathname.startsWith('/projects/'));
                      return `rail-item${active ? ' active' : ''}`;
                    }}
                  >
                    <Icon size={16} className="rail-item-icon" aria-hidden="true" />
                    <span className="rail-item-label">{item.label}</span>
                    {renderCount(item.countKey)}
                  </NavLink>

                  {item.children && devicesOpen && item.to === '/devices' && (
                    <div className="rail-sub">
                      {item.children.map((child) => {
                        const active = child.end
                          ? pathname === child.to || isDeviceDetail(pathname)
                          : pathname === child.to;
                        return (
                          <Link
                            key={child.to}
                            to={child.to}
                            className={`rail-sub-item${active ? ' active' : ''}`}
                          >
                            <span className="rail-item-label">{child.label}</span>
                            {renderCount(child.countKey)}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        ))}
      </div>

      <div className="rail-foot">
        <button
          type="button"
          className="rail-foot-btn"
          onClick={() => setOverride(!collapsed)}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          {!collapsed && <span className="rail-item-label">Collapse</span>}
        </button>

        <button
          type="button"
          className="rail-foot-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle dark mode"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          {!collapsed && (
            <span className="rail-item-label">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          )}
        </button>

        <div className="rail-user">
          <span className="rail-avatar" aria-hidden="true">
            {(user?.username || '?').slice(0, 2).toUpperCase()}
          </span>
          {!collapsed && <span className="rail-username">{user?.username}</span>}
          <button
            type="button"
            className="rail-logout"
            onClick={logout}
            title="Log out"
            aria-label="Log out"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </nav>
  );
}
