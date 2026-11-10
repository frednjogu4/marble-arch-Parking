// Authentication, RBAC permission matrix (single source of truth).
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_EXPIRES = '8h';

const PERMISSIONS = [
  ['dashboard.view', 'View dashboard'],
  ['sessions.view', 'View parking sessions / verify tickets'],
  ['sessions.entry', 'Register vehicle entry'],
  ['sessions.exit', 'Process vehicle exit'],
  ['sessions.move', 'Move vehicle between spaces'],
  ['sessions.void', 'Void an active session'],
  ['sessions.override', 'Override duplicate session / backdate entry'],
  ['spaces.view', 'View parking spaces / occupancy'],
  ['spaces.manage', 'Manage spaces (status, type)'],
  ['payments.view', 'View payments'],
  ['payments.collect', 'Collect payments'],
  ['payments.refund.request', 'Request a refund'],
  ['payments.refund.approve', 'Approve / process refunds'],
  ['mpesa.view', 'View M-Pesa transactions'],
  ['mpesa.manage', 'Initiate M-Pesa STK push'],
  ['discounts.apply', 'Apply / request a discount'],
  ['discounts.approve', 'Approve discounts'],
  ['complimentary.view', 'View complimentary records'],
  ['complimentary.authorize', 'Authorize complimentary parking'],
  ['monthly.view', 'View monthly parking'],
  ['monthly.manage', 'Manage monthly packages & subscriptions'],
  ['customers.view', 'View customers'],
  ['customers.manage', 'Manage customers'],
  ['shifts.view', 'View shifts'],
  ['shifts.open', 'Open a shift'],
  ['shifts.close', 'Close own shift'],
  ['shifts.review', 'Review shifts'],
  ['recon.view', 'View reconciliation'],
  ['recon.edit', 'Prepare / edit reconciliation draft'],
  ['recon.review.supervisor', 'Supervisor reconciliation review'],
  ['recon.review.controller', 'Controller reconciliation review'],
  ['recon.finalize', 'Finalize reconciliation (manager)'],
  ['reports.view', 'View operational reports'],
  ['reports.financial', 'View financial reports'],
  ['reports.export', 'Export / print reports'],
  ['users.view', 'View users'],
  ['users.manage', 'Manage users & roles'],
  ['settings.view', 'View hotel settings'],
  ['settings.manage', 'Manage hotel settings'],
  ['promotions.manage', 'Manage promotions'],
  ['audit.view', 'View audit logs'],
  ['notifications.view', 'View notifications'],
  ['billing.view', 'View invoices & billing'],
  ['billing.manage', 'Create / edit / void invoices'],
  ['settlement.view', 'View settlement summaries'],
  ['access.view', 'Use access control / view access log'],
  ['validations.view', 'View hotel validation codes'],
  ['validations.manage', 'Issue / revoke validation codes']
];

const ALL = PERMISSIONS.map(p => p[0]);

// Role -> permission codes ('*' = everything)
const ROLE_PERMS = {
  'Administrator': ['*'],
  'Manager': ['dashboard.view', 'sessions.view', 'spaces.view', 'payments.view',
    'payments.refund.approve', 'discounts.approve', 'complimentary.view', 'complimentary.authorize',
    'monthly.view', 'customers.view', 'shifts.view', 'shifts.review',
    'recon.view', 'recon.finalize', 'reports.view', 'reports.financial', 'reports.export',
    'users.view', 'settings.view', 'audit.view', 'notifications.view',
    'billing.view',
    'billing.manage', 'settlement.view', 'access.view',
    'validations.view', 'validations.manage'],
  'Controller': ['dashboard.view', 'sessions.view', 'spaces.view', 'payments.view',
    'mpesa.view', 'discounts.approve', 'payments.refund.approve', 'complimentary.view',
    'monthly.view', 'customers.view', 'shifts.view', 'shifts.review',
    'recon.view', 'recon.edit', 'recon.review.controller',
    'reports.view', 'reports.financial', 'reports.export',
    'settings.view', 'audit.view', 'notifications.view',
    'billing.view',
    'settlement.view', 'access.view',
    'validations.view', 'validations.manage'],
  'Supervisor': ['dashboard.view', 'sessions.view', 'sessions.entry', 'sessions.move',
    'sessions.void', 'sessions.override', 'spaces.view',
    'complimentary.view', 'complimentary.authorize', 'discounts.apply',
    'monthly.view', 'customers.view', 'customers.manage',
    'shifts.view', 'shifts.review', 'recon.view', 'recon.review.supervisor',
    'reports.view', 'reports.export', 'settings.view', 'notifications.view',
    'billing.view',
    'access.view',
    'validations.view', 'validations.manage'],
  'Cashier': ['dashboard.view', 'sessions.view', 'sessions.exit', 'spaces.view',
    'payments.view', 'payments.collect', 'payments.refund.request', 'discounts.apply',
    'monthly.view', 'customers.view', 'shifts.view', 'shifts.open', 'shifts.close',
    'reports.view', 'settings.view', 'notifications.view', 'mpesa.view',
    'billing.view',
    'access.view',
    'validations.view'],
  'Parking Attendant': ['dashboard.view', 'sessions.view', 'sessions.entry', 'sessions.exit',
    'sessions.move', 'spaces.view', 'payments.view', 'payments.collect', 'discounts.apply',
    'monthly.view', 'customers.view', 'shifts.view', 'shifts.open', 'shifts.close',
    'reports.view', 'settings.view', 'notifications.view', 'mpesa.view',
    'access.view'],
  'Security': ['dashboard.view', 'sessions.view', 'spaces.view', 'complimentary.view',
    'settings.view', 'notifications.view',
    'access.view'],
  'Accounts': ['dashboard.view', 'sessions.view', 'spaces.view', 'payments.view',
    'mpesa.view', 'monthly.view', 'customers.view', 'shifts.view',
    'recon.view', 'reports.view', 'reports.financial', 'reports.export',
    'settings.view', 'audit.view', 'notifications.view',
    'billing.view',
    'billing.manage', 'settlement.view', 'access.view',
    'validations.view', 'validations.manage']
};

function roleHasPermission(roleName, code) {
  const perms = ROLE_PERMS[roleName] || [];
  return perms.includes('*') || perms.includes(code);
}

function expandPermissions(roleName) {
  const perms = ROLE_PERMS[roleName] || [];
  return perms.includes('*') ? ALL.slice() : perms.slice();
}

function signToken(user) {
  const secret = process.env.JWT_SECRET || 'dev-secret-CHANGE-ME';
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role_name },
    secret,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  const secret = process.env.JWT_SECRET || 'dev-secret-CHANGE-ME';
  return jwt.verify(token, secret);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash || '');
}

module.exports = {
  PERMISSIONS, ROLE_PERMS, ALL,
  roleHasPermission, expandPermissions,
  signToken, verifyToken, hashPassword, checkPassword
};
