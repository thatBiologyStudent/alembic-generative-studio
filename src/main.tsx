import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { ProjectList } from './features/projects/ProjectList';
import { Workspace } from './features/workspace/Workspace';
import { SettingsPage } from './features/settings/SettingsPage';
import { OAuthCallback } from './features/settings/OAuthCallback';
import { Toasts } from './components/Toasts';
import { OutputFolderBanner } from './components/OutputFolderBanner';
import { PwaUpdatePrompt } from './components/Pwa';
import { SyncDialogHost } from './features/sync/SyncDialog';
import { SiteAnalytics } from './components/SiteAnalytics';
import { ensureDemoConnections } from './features/settings/bootstrap';
import { BASE } from './lib/base';
import { cleanupPendingSignIns } from './lib/oauth';
import { DramatisBridge } from './components/DramatisBridge';
import { initDramatisBridge } from './lib/dramatis';
import { ErrorBoundary } from './components/CrashScreen';

// the app started: the startup watchdog in index.html can stand down
(window as any).__alembicBooted = true;
void ensureDemoConnections();
cleanupPendingSignIns();
initDramatisBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
    <BrowserRouter basename={BASE.replace(/\/+$/, '') || undefined}>
      <Routes>
        <Route path="/" element={<ProjectList />} />
        <Route path="/p/:id" element={<Workspace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/oauth/callback" element={<OAuthCallback />} />
        <Route path="*" element={<ProjectList />} />
      </Routes>
      <Toasts />
      <OutputFolderBanner />
      <PwaUpdatePrompt />
      <SyncDialogHost />
      <SiteAnalytics />
      <DramatisBridge />
    </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
