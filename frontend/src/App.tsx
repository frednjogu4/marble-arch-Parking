import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequirePerm } from './auth';
import { ToastProvider } from './ui';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Entry from './pages/Entry';
import Exit from './pages/Exit';
import LiveView from './pages/LiveView';
import Parking from './pages/Parking';
import Customers from './pages/Customers';
import Monthly from './pages/Monthly';
import Payments from './pages/Payments';
import Shifts from './pages/Shifts';
import Reports from './pages/Reports';
import Recon from './pages/Recon';
import Promotions from './pages/Promotions';
import Users from './pages/Users';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import Notifications from './pages/Notifications';
import Billing from './pages/Billing';
import Settlement from './pages/Settlement';
import Access from './pages/Access';
import Validations from './pages/Validations';
import Rates from './pages/Rates';
import DailyReport from './pages/DailyReport';

const P = ({ any, el }: { any: string[]; el: JSX.Element }) => <RequirePerm any={any}>{el}</RequirePerm>;

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireAuth><Layout /></RequireAuth>}>
              <Route path="/" element={<P any={['dashboard.view']} el={<Dashboard />} />} />
              <Route path="/parking" element={<P any={['sessions.view']} el={<Parking />} />} />
              <Route path="/entry" element={<P any={['sessions.entry']} el={<Entry />} />} />
              <Route path="/exit" element={<P any={['sessions.exit']} el={<Exit />} />} />
              <Route path="/live" element={<P any={['spaces.view', 'sessions.view']} el={<LiveView />} />} />
              <Route path="/customers" element={<P any={['customers.view']} el={<Customers />} />} />
              <Route path="/monthly" element={<P any={['monthly.view']} el={<Monthly />} />} />
              <Route path="/payments" element={<P any={['payments.view']} el={<Payments />} />} />
              <Route path="/shifts" element={<P any={['shifts.view']} el={<Shifts />} />} />
              <Route path="/reports" element={<P any={['reports.view']} el={<Reports />} />} />
              <Route path="/reconciliation" element={<P any={['recon.view']} el={<Recon />} />} />
              <Route path="/promotions" element={<P any={['discounts.apply', 'promotions.manage']} el={<Promotions />} />} />
              <Route path="/billing" element={<P any={['billing.view']} el={<Billing />} />} />
              <Route path="/settlement" element={<P any={['settlement.view']} el={<Settlement />} />} />
              <Route path="/access" element={<P any={['access.view']} el={<Access />} />} />
              <Route path="/validations" element={<P any={['validations.view']} el={<Validations />} />} />
              <Route path="/rates" element={<P any={['settings.view']} el={<Rates />} />} />
              <Route path="/daily" element={<P any={['reports.view', 'access.view']} el={<DailyReport />} />} />
              <Route path="/users" element={<P any={['users.view']} el={<Users />} />} />
              <Route path="/audit" element={<P any={['audit.view']} el={<Audit />} />} />
              <Route path="/settings" element={<P any={['settings.view']} el={<Settings />} />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
