import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';
import Navbar from './components/Navbar';
import TopologyPage from './pages/Topology';
import RacksPage from './pages/Racks';
import DevicesPage from './pages/Devices';
import ScanPage from './pages/Scan';
import './App.css';

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Navbar />
        <main className="app-content">
          <Routes>
            <Route path="/" element={<Navigate to="/topology" replace />} />
            <Route path="/topology" element={<TopologyPage />} />
            <Route path="/racks" element={<RacksPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/devices/:id" element={<DevicesPage />} />
            <Route path="/scan" element={<ScanPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
