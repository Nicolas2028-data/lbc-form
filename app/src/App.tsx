import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import StaffLayout from './pages/StaffLayout';
import Login from './pages/Login';
import Patients from './pages/Patients';
import Record from './pages/Record';
import Dashboard from './pages/Dashboard';
import CustomerDetail from './pages/CustomerDetail';
import Questionnaire from './pages/Questionnaire';
import Book from './pages/Book';
import BookingManage from './pages/BookingManage';
import Bookings from './pages/Bookings';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/q" element={<Questionnaire />} />
        <Route path="/book" element={<Book />} />
        <Route path="/b/:token" element={<BookingManage />} />
        <Route path="/staff/login" element={<Login />} />
        <Route path="/staff" element={<StaffLayout />}>
          <Route index element={<Patients />} />
          <Route path="record/:customerId" element={<Record />} />
          <Route path="customers/:customerId" element={<CustomerDetail />} />
          <Route path="bookings" element={<Bookings />} />
          <Route path="dashboard" element={<Dashboard />} />
        </Route>
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
