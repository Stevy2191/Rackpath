import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import './Navbar.css';

const links = [
  { to: '/topology', label: 'Topology' },
  { to: '/racks', label: 'Racks' },
  { to: '/devices', label: 'Devices' },
  { to: '/scan', label: 'Scan' },
];

export default function Navbar() {
  const { user, logout } = useAuth();

  return (
    <nav className="navbar">
      <div className="navbar-brand">Rackpath</div>
      <div className="navbar-links">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => `navbar-link${isActive ? ' active' : ''}`}
          >
            {link.label}
          </NavLink>
        ))}
      </div>
      <div className="navbar-user">
        {user && <span className="navbar-username">{user.username}</span>}
        <button className="navbar-logout" onClick={logout}>
          Logout
        </button>
      </div>
    </nav>
  );
}
