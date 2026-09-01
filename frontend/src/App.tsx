import { Navigate, Route, Routes } from 'react-router-dom'
import { PERMISSIONS } from '@asps-dms/shared'
import { AppLayout } from './components/AppLayout.js'
import { ProtectedRoute } from './components/ProtectedRoute.js'
import { ChangePasswordPage } from './features/auth/ChangePasswordPage.js'
import { LoginPage } from './features/auth/LoginPage.js'
import { RegisterPage } from './features/auth/RegisterPage.js'
import { EmployeeDetailPage } from './features/employees/EmployeeDetailPage.js'
import { EmployeeFormPage } from './features/employees/EmployeeFormPage.js'
import { EmployeeListPage } from './features/employees/EmployeeListPage.js'
import { ComingSoonPage } from './pages/ComingSoonPage.js'
import { ReportsPage } from './pages/ReportsPage.js'
import { MySignaturePage } from './pages/MySignaturePage.js'
import { PlacementEditorPage } from './features/signatures/PlacementEditorPage.js'
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
      {/* Public, like /login: registering is what someone does when they have no
          account to sign in with. The cap on it is enforced server-side. */}
      <Route path="/register" element={<RegisterPage />} />

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
              <EmployeeListPage />
            </ProtectedRoute>
          }
        />
        {/* Declared before 'employees/:employeeId' so 'new' is a route and not
            an employee id that would fail to parse. */}
        <Route
          path="employees/new"
          element={
            <ProtectedRoute permission={PERMISSIONS.EMPLOYEE_CREATE}>
              <EmployeeFormPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="employees/:employeeId"
          element={
            <ProtectedRoute permission={PERMISSIONS.EMPLOYEE_READ}>
              <EmployeeDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="employees/:employeeId/edit"
          element={
            <ProtectedRoute permission={PERMISSIONS.EMPLOYEE_UPDATE}>
              <EmployeeFormPage />
            </ProtectedRoute>
          }
        />
        {/* Positioning signatures on one document. Keyed by document rather
            than employee: the placements belong to the file, not the person. */}
        <Route
          path="documents/:documentId/signature"
          element={
            <ProtectedRoute permission={PERMISSIONS.SIGNATURE_PLACE}>
              <PlacementEditorPage />
            </ProtectedRoute>
          }
        />
        {/* The user's own authorising signature. No id in the path: there is
            no screen that sets somebody else's. */}
        <Route
          path="my-signature"
          element={
            <ProtectedRoute permission={PERMISSIONS.SIGNATURE_UPLOAD}>
              <MySignaturePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="reports"
          element={
            <ProtectedRoute permission={PERMISSIONS.REPORT_READ}>
              <ReportsPage />
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
