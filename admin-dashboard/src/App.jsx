import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { useAuth } from './context/AuthContext'
import { Accounts } from './pages/Accounts'
import { AddAccount } from './pages/AddAccount'
import { Dashboard } from './pages/Dashboard'
import { Login } from './pages/Login'
import { Orders } from './pages/Orders'
import { OrdersHistory } from './pages/OrdersHistory'
import { Stats } from './pages/Stats'

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/history" element={<OrdersHistory />} />
        <Route path="stats" element={<Stats />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="add-account" element={<AddAccount />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
