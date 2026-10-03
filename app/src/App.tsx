import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import StaffLayout from './pages/StaffLayout';
import Login from './pages/Login';
import Patients from './pages/Patients';
import Record from './pages/Record';
import Dashboard from './pages/Dashboard';
import CustomerDetail from './pages/CustomerDetail';
import Questionnaire from './pages/Questionnaire';
// 予約機能は 2026-10-03 Nicolas の判断で非表示(画面: pages/Book.tsx・BookingManage.tsx・Bookings.tsx、
// DB: migration 0008 は残す)。再開するときはルートとメニューを戻し、migration 0009 の revoke を取り消す

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/q" element={<Questionnaire />} />
        <Route path="/staff/login" element={<Login />} />
        <Route path="/staff" element={<StaffLayout />}>
          <Route index element={<Patients />} />
          <Route path="record/:customerId" element={<Record />} />
          <Route path="customers/:customerId" element={<CustomerDetail />} />
          <Route path="dashboard" element={<Dashboard />} />
        </Route>
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
