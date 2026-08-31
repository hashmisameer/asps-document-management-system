import { Navigate, Route, Routes } from 'react-router-dom'
import { PERMISSIONS } from '@asps-dms/shared'
import { AppLayout } from './components/AppLayout.js'
import { ProtectedRoute } from './components/ProtectedRoute.js'
import { ChangePasswordPage } from './features/auth/ChangePasswordPage.js'
import { LoginPage } from './features/auth/LoginPage.js'
import { ComingSoonPage } from './pages/ComingSoonPage.js'
import { DashboardPage } from './pages/DashboardPage.js'

/**
 * Routing.
 *
 * /login is the only route outside the gate. Everything else goes through
 * ProtectedRoute, which sends a signed-out user to the login form and an
 * account that must change its password to the one page that lets it.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/change-password"
        element={
          <ProtectedRoute allowPasswordChangePending>
            <ChangePasswordPage />
          </ProtectedRoute>
        }
      />

      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route
          path="employees"
          element={
            <ProtectedRoute permission={PERMISSIONS.EMPLOYEE_READ}>
              <ComingSoonPage title="Employees" milestone="Milestone 3" />
            </ProtectedRoute>
          }
        />
        <Route
          path="reports"
          element={
            <ProtectedRoute permission={PERMISSIONS.REPORT_READ}>
              <ComingSoonPage title="Reports" milestone="Milestone 5" />
            </ProtectedRoute>
          }
        />
        <Route
          path="users"
          element={
            <ProtectedRoute permission={PERMISSIONS.USER_MANAGE}>
              <ComingSoonPage title="Users" milestone="Milestone 2" />
            </ProtectedRoute>
          }
        />
      </Route>

      {/* An unknown path is a mistyped or stale link, not an error worth a page. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
