import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { ProjectList } from './features/projects/ProjectList';
import { Workspace } from './features/workspace/Workspace';
import { SettingsPage } from './features/settings/SettingsPage';
import { Toasts } from './components/Toasts';
import { OutputFolderBanner } from './components/OutputFolderBanner';
import { ensureDemoConnections } from './features/settings/bootstrap';

void ensureDemoConnections();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectList />} />
        <Route path="/p/:id" element={<Workspace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<ProjectList />} />
      </Routes>
      <Toasts />
      <OutputFolderBanner />
    </BrowserRouter>
  </React.StrictMode>,
);
