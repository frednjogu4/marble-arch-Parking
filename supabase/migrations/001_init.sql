-- =====================================================================
-- Marble Arch Hotel Nairobi - Parking Management System
-- Supabase / PostgreSQL production schema + Row Level Security.
--
-- Deploy: supabase db push  (or run in the Supabase SQL editor)
-- App users authenticate via Supabase Auth with app_metadata.role set to one
-- of: Administrator, Manager, Controller, Supervisor, Cashier,
-- Parking Attendant, Security, Accounts.
-- The Node API (backend/) remains the primary enforcement point and uses the
-- service-role key server-side ONLY. These policies protect direct access.
-- =====================================================================

-- ---------- helpers ----------
create or replace function public.current_role() returns text
language sql stable as $$
  select coalesce(auth.jwt()->'app_metadata'->>'role', '');
$$;

create or replace function public.current_user_id() returns uuid
language sql stable as $$ select auth.uid(); $$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------- roles & permissions ----------
create table if not exists public.roles (
  id serial primary key,
  name text not null unique,
  description text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.permissions (
  id serial primary key,
  code text not null unique,
  description text default ''
);

create table if not exists public.role_permissions (
  role_id int not null references public.roles(id),
  permission_id int not null references public.permissions(id),
  primary key (role_id, permission_id)
);

create or replace function public.has_perm(p_code text) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.roles r
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where r.name = public.current_role() and p.code = p_code
  ) or public.current_role() = 'Administrator';
$$;

-- App user profiles (1:1 with auth.users).
create table if not exists public.app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  username text not null unique,
  phone text default '',
  role_id int not null references public.roles(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists trg_app_users_touch on public.app_users;
create trigger trg_app_users_touch before update on public.app_users
  for each row execute function public.touch_updated_at();

-- ---------- hotel settings (singleton id=1) ----------
create table if not exists public.hotel_settings (
  id int primary key check (id = 1),
  hotel_name text not null default 'Marble Arch Hotel Nairobi',
  logo_data text default '',
  address text not null default '',
  phones text not null default '',
  email text not null default '',
  website text not null default '',
  registration_details text not null default '',
  parking_department text not null default 'Parking Department',
  parking_location text not null default 'Marble Arch Hotel Nairobi',
  total_spaces int not null default 150,
  daily_rate numeric(12,2) not null default 400,
  hourly_enabled boolean not null default false,
  hourly_rate numeric(12,2) not null default 100,
  grace_period_minutes int not null default 15,
  currency text not null default 'KES',
  receipt_header text not null default '',
  lost_ticket_fee numeric(12,2) not null default 1000,
  receipt_footer text not null default 'Thank you for parking with us.',
  terms text not null default '',
  social_facebook text not null default '',
  social_twitter text not null default '',
  social_instagram text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.app_users(id)
);
insert into public.hotel_settings (id) values (1) on conflict (id) do nothing;

-- ---------- parking ----------
create table if not exists public.parking_spaces (
  id serial primary key,
  code text not null unique,
  zone text not null default 'A',
  space_type text not null default 'standard'
    check (space_type in ('standard','reserved','vip','disabled','staff','motorcycle')),
  status text not null default 'available'
    check (status in ('available','occupied','reserved','out_of_service')),
  current_session_id int,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_spaces_status on public.parking_spaces(status);

create table if not exists public.parking_categories (
  id serial primary key,
  code text not null unique,
  name text not null,
  kind text not null check (kind in ('paid','complimentary')),
  description text default '',
  active boolean not null default true,
  hourly_rate numeric(12,2),
  daily_rate numeric(12,2),
  max_charge numeric(12,2),
  grace_minutes int
);

create table if not exists public.customers (
  id serial primary key,
  name text not null,
  phone text not null default '',
  email text not null default '',
  company text not null default '',
  customer_type text not null default 'casual',
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_customers_phone on public.customers(phone);

create table if not exists public.vehicles (
  id serial primary key,
  registration text not null unique,
  vehicle_type text not null default 'Saloon',
  make text not null default '',
  model text not null default '',
  color text not null default '',
  customer_id int references public.customers(id),
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_vehicles_reg on public.vehicles(registration);

create table if not exists public.monthly_packages (
  id serial primary key,
  name text not null unique,
  price numeric(12,2) not null default 0,
  validity_days int not null default 30,
  reserved_space boolean not null default false,
  vehicle_limit int not null default 1,
  benefits text default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.monthly_subscriptions (
  id serial primary key,
  customer_id int references public.customers(id),
  customer_name text not null,
  company text not null default '',
  phone text not null default '',
  email text not null default '',
  registration text not null,
  vehicle_type text not null default 'Saloon',
  package_id int not null references public.monthly_packages(id),
  start_date date not null,
  expiry_date date not null,
  amount numeric(12,2) not null default 0,
  payment_method text not null default 'cash',
  payment_reference text not null default '',
  status text not null default 'active' check (status in ('active','expired','suspended','cancelled')),
  renewed_from int references public.monthly_subscriptions(id),
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_subs_reg on public.monthly_subscriptions(registration);
create index if not exists idx_subs_status on public.monthly_subscriptions(status);

create table if not exists public.subscription_payments (
  id serial primary key,
  subscription_id int not null references public.monthly_subscriptions(id),
  amount numeric(12,2) not null,
  method text not null,
  reference text not null default '',
  shift_id int,
  paid_at timestamptz not null,
  received_by uuid references public.app_users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.parking_sessions (
  id serial primary key,
  ticket_no text not null unique,
  vehicle_id int not null references public.vehicles(id),
  registration text not null,
  customer_name text not null default '',
  phone text not null default '',
  category_id int not null references public.parking_categories(id),
  monthly_subscription_id int references public.monthly_subscriptions(id),
  space_id int references public.parking_spaces(id),
  entry_time timestamptz not null,
  exit_time timestamptz,
  status text not null default 'active' check (status in ('active','exited','voided')),
  base_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid','complimentary')),
  entry_user_id uuid references public.app_users(id),
  exit_user_id uuid references public.app_users(id),
  created_offline boolean not null default false,
  lost_ticket boolean not null default false,
  lost_id_number text not null default '',
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sessions_status on public.parking_sessions(status);
create index if not exists idx_sessions_reg on public.parking_sessions(registration);
create index if not exists idx_sessions_ticket on public.parking_sessions(ticket_no);
create index if not exists idx_sessions_entry on public.parking_sessions(entry_time);

alter table public.parking_spaces
  drop constraint if exists parking_spaces_current_session_id_fkey;
alter table public.parking_spaces
  add constraint parking_spaces_current_session_id_fkey
  foreign key (current_session_id) references public.parking_sessions(id);

create table if not exists public.tickets (
  id serial primary key,
  session_id int not null references public.parking_sessions(id),
  ticket_no text not null unique,
  issued_at timestamptz not null,
  issued_by uuid references public.app_users(id),
  printed_count int not null default 0
);

create table if not exists public.shifts (
  id serial primary key,
  user_id uuid not null references public.app_users(id),
  station text not null default 'Main Gate',
  opened_at timestamptz not null,
  opening_cash numeric(12,2) not null default 0,
  status text not null default 'open' check (status in ('open','closed')),
  closed_at timestamptz,
  expected_cash numeric(12,2) not null default 0,
  actual_cash numeric(12,2),
  expected_mpesa numeric(12,2) not null default 0,
  actual_mpesa numeric(12,2),
  expected_card numeric(12,2) not null default 0,
  actual_card numeric(12,2),
  variance_note text default '',
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id serial primary key,
  session_id int references public.parking_sessions(id),
  subscription_id int references public.monthly_subscriptions(id),
  amount numeric(12,2) not null,
  method text not null check (method in ('cash','mpesa','card')),
  reference text not null default '',
  verification_status text not null default 'manual'
    check (verification_status in ('verified','manual','pending','failed')),
  terminal text not null default '',
  shift_id int references public.shifts(id),
  invoice_id int references public.invoices(id),
  received_by uuid references public.app_users(id),
  paid_at timestamptz not null,
  notes text default '',
  created_at timestamptz not null default now(),
  check (session_id is not null or subscription_id is not null or invoice_id is not null)
);
create index if not exists idx_payments_session on public.payments(session_id);
create index if not exists idx_payments_invoice on public.payments(invoice_id);
create index if not exists idx_payments_shift on public.payments(shift_id);
create index if not exists idx_payments_paid on public.payments(paid_at);

alter table public.subscription_payments
  drop constraint if exists subscription_payments_shift_id_fkey;
alter table public.subscription_payments
  add constraint subscription_payments_shift_id_fkey
  foreign key (shift_id) references public.shifts(id);

create table if not exists public.payment_transactions (
  id serial primary key,
  payment_id int references public.payments(id),
  session_id int references public.parking_sessions(id),
  provider text not null default 'mpesa',
  provider_ref text default '',
  mpesa_receipt text default '',
  phone text not null default '',
  amount numeric(12,2) not null default 0,
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled','reversed')),
  raw_callback text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.promotions (
  id serial primary key,
  name text not null,
  kind text not null check (kind in ('percentage','fixed','free','time_based','event','guest')),
  value numeric(12,2) not null default 0,
  conditions jsonb not null default '{}',
  active boolean not null default true,
  valid_from date,
  valid_to date,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.discounts (
  id serial primary key,
  session_id int not null references public.parking_sessions(id),
  promotion_id int references public.promotions(id),
  original_amount numeric(12,2) not null,
  discount_amount numeric(12,2) not null,
  final_amount numeric(12,2) not null,
  reason text not null default '',
  applied_by uuid references public.app_users(id),
  approved_by uuid references public.app_users(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected','applied')),
  validation_code text not null default '',
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- ---------- billing / access / gate (v3 + merge mirror) ----------
create table if not exists public.invoices (
  id serial primary key,
  invoice_no text not null unique,
  customer_name text not null default '',
  company text not null default '',
  phone text not null default '',
  email text not null default '',
  registration text not null default '',
  subscription_id int references public.monthly_subscriptions(id),
  session_id int references public.parking_sessions(id),
  issue_date date not null,
  due_date date not null,
  subtotal numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  balance numeric(12,2) not null default 0,
  status text not null default 'unpaid' check (status in ('unpaid','partial','paid','voided')),
  notes text default '',
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_invoices_status on public.invoices(status);
create index if not exists idx_invoices_due on public.invoices(due_date);

create table if not exists public.invoice_items (
  id serial primary key,
  invoice_id int not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity numeric(12,2) not null default 1,
  unit_price numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0
);
create index if not exists idx_invitems_inv on public.invoice_items(invoice_id);

create table if not exists public.access_logs (
  id serial primary key,
  registration text not null,
  verdict text not null check (verdict in ('AUTHORIZED','DENIED')),
  reason text not null default '',
  subscription_id int references public.monthly_subscriptions(id),
  session_id int references public.parking_sessions(id),
  checked_by uuid references public.app_users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_access_reg on public.access_logs(registration);
create index if not exists idx_access_created on public.access_logs(created_at);

create table if not exists public.validation_codes (
  id serial primary key,
  code text not null unique,
  max_amount numeric(12,2),
  status text not null default 'unused' check (status in ('unused','used','expired','revoked')),
  expires_at timestamptz,
  notes text default '',
  created_by uuid references public.app_users(id),
  used_by_session int references public.parking_sessions(id),
  used_amount numeric(12,2) not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_valid_code on public.validation_codes(code);
create index if not exists idx_valid_status on public.validation_codes(status);

create table if not exists public.gate_logs (
  id serial primary key,
  session_id int references public.parking_sessions(id),
  action text not null default 'open' check (action in ('open','override')),
  reason text not null default '',
  opened_by uuid references public.app_users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_gate_created on public.gate_logs(created_at);

create table if not exists public.complimentary_authorizations (
  id serial primary key,
  session_id int not null references public.parking_sessions(id),
  comp_category text not null,
  reason text not null default '',
  reference text not null default '',
  authorized_by text not null,
  recorded_by uuid references public.app_users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.shift_transactions (
  id serial primary key,
  shift_id int not null references public.shifts(id),
  payment_id int not null unique references public.payments(id),
  created_at timestamptz not null default now()
);

create table if not exists public.daily_reconciliations (
  id serial primary key,
  recon_date date not null unique,
  total_cash numeric(12,2) not null default 0,
  total_mpesa numeric(12,2) not null default 0,
  total_card numeric(12,2) not null default 0,
  total_revenue numeric(12,2) not null default 0,
  paid_vehicles int not null default 0,
  complimentary_vehicles int not null default 0,
  monthly_vehicles int not null default 0,
  total_vehicles int not null default 0,
  discounts_total numeric(12,2) not null default 0,
  refunds_total numeric(12,2) not null default 0,
  variance numeric(12,2) not null default 0,
  status text not null default 'draft'
    check (status in ('draft','supervisor_reviewed','controller_reviewed','finalized')),
  supervisor_by uuid references public.app_users(id),
  supervisor_at timestamptz,
  controller_by uuid references public.app_users(id),
  controller_at timestamptz,
  manager_by uuid references public.app_users(id),
  manager_at timestamptz,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.refunds (
  id serial primary key,
  payment_id int not null references public.payments(id),
  session_id int references public.parking_sessions(id),
  amount numeric(12,2) not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','processed')),
  requested_by uuid references public.app_users(id),
  approved_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.audit_logs (
  id bigserial primary key,
  user_id uuid references public.app_users(id),
  username text not null default '',
  role text not null default '',
  action text not null,
  module text not null,
  record_id text not null default '',
  old_value text default '',
  new_value text default '',
  ip text default '',
  user_agent text default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on public.audit_logs(created_at);
create index if not exists idx_audit_action on public.audit_logs(action);

create table if not exists public.notifications (
  id serial primary key,
  type text not null,
  title text not null,
  message text not null default '',
  link text not null default '',
  audience_role text default '',
  user_id uuid references public.app_users(id),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- seed roles / permissions (mirrors backend/src/auth.js) ----------
insert into public.roles (name) values
  ('Administrator'),('Manager'),('Controller'),('Supervisor'),
  ('Cashier'),('Parking Attendant'),('Security'),('Accounts')
on conflict (name) do nothing;

insert into public.permissions (code) values
  ('dashboard.view'),('sessions.view'),('sessions.entry'),('sessions.exit'),
  ('sessions.move'),('sessions.void'),('sessions.override'),
  ('spaces.view'),('spaces.manage'),
  ('payments.view'),('payments.collect'),('payments.refund.request'),('payments.refund.approve'),
  ('mpesa.view'),('mpesa.manage'),
  ('discounts.apply'),('discounts.approve'),
  ('complimentary.view'),('complimentary.authorize'),
  ('monthly.view'),('monthly.manage'),
  ('customers.view'),('customers.manage'),
  ('shifts.view'),('shifts.open'),('shifts.close'),('shifts.review'),
  ('recon.view'),('recon.edit'),('recon.review.supervisor'),('recon.review.controller'),('recon.finalize'),
  ('reports.view'),('reports.financial'),('reports.export'),
  ('users.view'),('users.manage'),
  ('settings.view'),('settings.manage'),
  ('promotions.manage'),('audit.view'),('notifications.view'),
  ('billing.view'),('billing.manage'),('settlement.view'),('access.view'),
  ('validations.view'),('validations.manage')
on conflict (code) do nothing;

-- helper to grant
create or replace function public.grant_perm(p_role text, p_code text) returns void
language plpgsql as $$
declare r int; p int;
begin
  select id into r from public.roles where name = p_role;
  select id into p from public.permissions where code = p_code;
  if r is not null and p is not null then
    insert into public.role_permissions (role_id, permission_id) values (r, p) on conflict do nothing;
  end if;
end $$;

-- Manager
select public.grant_perm('Manager', x) from (values
  ('dashboard.view'),('sessions.view'),('spaces.view'),('payments.view'),
  ('payments.refund.approve'),('discounts.approve'),('complimentary.view'),('complimentary.authorize'),
  ('monthly.view'),('customers.view'),('shifts.view'),('shifts.review'),
  ('recon.view'),('recon.finalize'),('reports.view'),('reports.financial'),('reports.export'),
  ('users.view'),('settings.view'),('audit.view'),('notifications.view'),
  ('billing.view'),('billing.manage'),('settlement.view'),('access.view'),
  ('validations.view'),('validations.manage')) v(x);
-- Controller
select public.grant_perm('Controller', x) from (values
  ('dashboard.view'),('sessions.view'),('spaces.view'),('payments.view'),
  ('mpesa.view'),('discounts.approve'),('payments.refund.approve'),('complimentary.view'),
  ('monthly.view'),('customers.view'),('shifts.view'),('shifts.review'),
  ('recon.view'),('recon.edit'),('recon.review.controller'),
  ('reports.view'),('reports.financial'),('reports.export'),
  ('settings.view'),('audit.view'),('notifications.view'),
  ('billing.view'),('settlement.view'),('access.view'),
  ('validations.view'),('validations.manage')) v(x);
-- Supervisor
select public.grant_perm('Supervisor', x) from (values
  ('dashboard.view'),('sessions.view'),('sessions.entry'),('sessions.move'),
  ('sessions.void'),('sessions.override'),('spaces.view'),
  ('complimentary.view'),('complimentary.authorize'),('discounts.apply'),
  ('monthly.view'),('customers.view'),('customers.manage'),
  ('shifts.view'),('shifts.review'),('recon.view'),('recon.review.supervisor'),
  ('reports.view'),('reports.export'),('settings.view'),('notifications.view'),
  ('billing.view'),('access.view'),('validations.view'),('validations.manage')) v(x);
-- Cashier
select public.grant_perm('Cashier', x) from (values
  ('dashboard.view'),('sessions.view'),('sessions.exit'),('spaces.view'),
  ('payments.view'),('payments.collect'),('payments.refund.request'),('discounts.apply'),
  ('monthly.view'),('customers.view'),('shifts.view'),('shifts.open'),('shifts.close'),
  ('reports.view'),('settings.view'),('notifications.view'),('mpesa.view'),
  ('billing.view'),('access.view'),('validations.view')) v(x);
-- Parking Attendant
select public.grant_perm('Parking Attendant', x) from (values
  ('dashboard.view'),('sessions.view'),('sessions.entry'),('sessions.exit'),
  ('sessions.move'),('spaces.view'),('payments.view'),('payments.collect'),('discounts.apply'),
  ('monthly.view'),('customers.view'),('shifts.view'),('shifts.open'),('shifts.close'),
  ('reports.view'),('settings.view'),('notifications.view'),('mpesa.view'),
  ('access.view')) v(x);
-- Security
select public.grant_perm('Security', x) from (values
  ('dashboard.view'),('sessions.view'),('spaces.view'),('complimentary.view'),
  ('settings.view'),('notifications.view'),('access.view')) v(x);
-- Accounts
select public.grant_perm('Accounts', x) from (values
  ('dashboard.view'),('sessions.view'),('spaces.view'),('payments.view'),
  ('mpesa.view'),('monthly.view'),('customers.view'),('shifts.view'),
  ('recon.view'),('reports.view'),('reports.financial'),('reports.export'),
  ('settings.view'),('audit.view'),('notifications.view'),
  ('billing.view'),('billing.manage'),('settlement.view'),('access.view'),
  ('validations.view'),('validations.manage')) v(x);

-- categories + packages
insert into public.parking_categories (code, name, kind) values
  ('daily','Daily Customer','paid'),('hourly','Hourly Customer','paid'),('monthly','Monthly Customer','paid'),
  ('accommodation','Hotel Accommodation Guest','complimentary'),('restaurant','Restaurant Customer','complimentary'),
  ('bar','Bar Customer','complimentary'),('conference','Conference / Function Customer','complimentary'),
  ('staff','Staff','complimentary'),('management','Management','complimentary'),
  ('vip','VIP','complimentary'),('authorized','Authorized Complimentary','complimentary'),
  ('official','Official Hotel Vehicle','complimentary')
on conflict (code) do nothing;

insert into public.monthly_packages (name, price, validity_days, reserved_space, vehicle_limit, benefits) values
  ('Monthly Standard', 6000, 30, false, 1, 'Standard monthly bay, one vehicle'),
  ('Monthly Reserved', 9000, 30, true, 1, 'Reserved numbered bay, one vehicle'),
  ('Corporate Monthly', 7500, 30, false, 1, 'Corporate rate, one vehicle'),
  ('Motorcycle Monthly', 2500, 30, false, 1, 'Motorcycle bay')
on conflict (name) do nothing;

-- 150 bays
insert into public.parking_spaces (code, zone, space_type, status)
select 'P-' || lpad(g::text, 3, '0'),
       case when g <= 50 then 'A' when g <= 100 then 'B' else 'C' end,
       case when g between 141 and 148 then 'reserved' else 'standard' end,
       case when g >= 149 then 'out_of_service' when g between 141 and 148 then 'reserved' else 'available' end
from generate_series(1, 150) g
on conflict (code) do nothing;

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.app_users enable row level security;
alter table public.hotel_settings enable row level security;
alter table public.parking_spaces enable row level security;
alter table public.parking_categories enable row level security;
alter table public.customers enable row level security;
alter table public.vehicles enable row level security;
alter table public.monthly_packages enable row level security;
alter table public.monthly_subscriptions enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.parking_sessions enable row level security;
alter table public.tickets enable row level security;
alter table public.shifts enable row level security;
alter table public.payments enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.promotions enable row level security;
alter table public.discounts enable row level security;
alter table public.complimentary_authorizations enable row level security;
alter table public.shift_transactions enable row level security;
alter table public.daily_reconciliations enable row level security;
alter table public.refunds enable row level security;
alter table public.audit_logs enable row level security;
alter table public.notifications enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.access_logs enable row level security;
alter table public.validation_codes enable row level security;
alter table public.gate_logs enable row level security;

-- roles/permissions readable by authenticated (needed for UI + has_perm)
create policy rp_read on public.roles for select to authenticated using (true);
create policy pm_read on public.permissions for select to authenticated using (true);
create policy rpm_read on public.role_permissions for select to authenticated using (true);

-- users: self read; users.view read all; users.manage write
create policy au_self on public.app_users for select to authenticated
  using (id = public.current_user_id() or public.has_perm('users.view'));
create policy au_write on public.app_users for all to authenticated
  using (public.has_perm('users.manage')) with check (public.has_perm('users.manage'));

-- settings: read authenticated; write settings.manage
create policy hs_read on public.hotel_settings for select to authenticated using (true);
create policy hs_write on public.hotel_settings for update to authenticated
  using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));

-- spaces: view + manage
create policy sp_read on public.parking_spaces for select to authenticated
  using (public.has_perm('spaces.view') or public.has_perm('sessions.view') or public.has_perm('dashboard.view'));
create policy sp_write on public.parking_spaces for update to authenticated
  using (public.has_perm('spaces.manage') or public.has_perm('sessions.entry') or public.has_perm('sessions.exit') or public.has_perm('sessions.move'))
  with check (true);

-- categories: read all; write settings.manage
create policy cat_read on public.parking_categories for select to authenticated using (true);
create policy cat_write on public.parking_categories for all to authenticated
  using (public.has_perm('settings.manage')) with check (public.has_perm('settings.manage'));

-- sessions: view/entry/exit/move/void/override
create policy ps_read on public.parking_sessions for select to authenticated using (public.has_perm('sessions.view'));
create policy ps_insert on public.parking_sessions for insert to authenticated
  with check (public.has_perm('sessions.entry'));
create policy ps_update on public.parking_sessions for update to authenticated
  using (public.has_perm('sessions.exit') or public.has_perm('sessions.move') or public.has_perm('sessions.void') or public.has_perm('sessions.override') or public.has_perm('payments.collect'))
  with check (true);

-- tickets: read with sessions.view; insert with entry
create policy tk_read on public.tickets for select to authenticated using (public.has_perm('sessions.view'));
create policy tk_ins on public.tickets for insert to authenticated with check (public.has_perm('sessions.entry'));

-- payments: view/collect (no direct update/delete; corrections via refunds)
create policy pay_read on public.payments for select to authenticated using (public.has_perm('payments.view'));
create policy pay_ins on public.payments for insert to authenticated with check (public.has_perm('payments.collect'));

-- mpesa txns: view; manage inserts/updates (service role handles callbacks)
create policy mpt_read on public.payment_transactions for select to authenticated
  using (public.has_perm('mpesa.view') or public.has_perm('payments.view'));
create policy mpt_ins on public.payment_transactions for insert to authenticated with check (public.has_perm('mpesa.manage'));
create policy mpt_upd on public.payment_transactions for update to authenticated using (public.has_perm('mpesa.manage'));

-- monthly: view/manage
create policy mp_read on public.monthly_packages for select to authenticated using (public.has_perm('monthly.view'));
create policy mp_write on public.monthly_packages for all to authenticated
  using (public.has_perm('monthly.manage')) with check (public.has_perm('monthly.manage'));
create policy ms_read on public.monthly_subscriptions for select to authenticated using (public.has_perm('monthly.view'));
create policy ms_write on public.monthly_subscriptions for all to authenticated
  using (public.has_perm('monthly.manage')) with check (public.has_perm('monthly.manage'));
create policy msp_read on public.subscription_payments for select to authenticated
  using (public.has_perm('monthly.view') or public.has_perm('payments.view'));
create policy msp_ins on public.subscription_payments for insert to authenticated
  with check (public.has_perm('monthly.manage'));

-- customers & vehicles
create policy cu_read on public.customers for select to authenticated using (public.has_perm('customers.view'));
create policy cu_write on public.customers for all to authenticated
  using (public.has_perm('customers.manage')) with check (public.has_perm('customers.manage'));
create policy ve_read on public.vehicles for select to authenticated
  using (public.has_perm('sessions.view') or public.has_perm('customers.view'));
create policy ve_write on public.vehicles for all to authenticated
  using (public.has_perm('sessions.entry') or public.has_perm('customers.manage'))
  with check (true);

-- promotions & discounts
create policy pr_read on public.promotions for select to authenticated
  using (public.has_perm('discounts.apply') or public.has_perm('promotions.manage'));
create policy pr_write on public.promotions for all to authenticated
  using (public.has_perm('promotions.manage')) with check (public.has_perm('promotions.manage'));
create policy di_read on public.discounts for select to authenticated
  using (public.has_perm('discounts.apply') or public.has_perm('discounts.approve') or public.has_perm('reports.view'));
create policy di_ins on public.discounts for insert to authenticated with check (public.has_perm('discounts.apply'));
create policy di_upd on public.discounts for update to authenticated using (public.has_perm('discounts.approve'));

-- complimentary: view + authorize
create policy ca_read on public.complimentary_authorizations for select to authenticated
  using (public.has_perm('complimentary.view') or public.has_perm('reports.view'));
create policy ca_ins on public.complimentary_authorizations for insert to authenticated
  with check (public.has_perm('complimentary.authorize'));

-- shifts: view/open/close-own/review (ownership enforced in API; RLS by perm)
create policy sh_read on public.shifts for select to authenticated using (public.has_perm('shifts.view'));
create policy sh_ins on public.shifts for insert to authenticated with check (public.has_perm('shifts.open'));
create policy sh_upd on public.shifts for update to authenticated
  using (public.has_perm('shifts.close') or public.has_perm('shifts.review'));

create policy sht_read on public.shift_transactions for select to authenticated
  using (public.has_perm('shifts.view') or public.has_perm('payments.view'));
create policy sht_ins on public.shift_transactions for insert to authenticated
  with check (public.has_perm('payments.collect'));

-- reconciliation: view/edit/review/finalize; finalized rows immutable
create policy rc_read on public.daily_reconciliations for select to authenticated using (public.has_perm('recon.view'));
create policy rc_ins on public.daily_reconciliations for insert to authenticated with check (public.has_perm('recon.edit'));
create policy rc_upd on public.daily_reconciliations for update to authenticated
  using ((public.has_perm('recon.edit') or public.has_perm('recon.review.supervisor') or public.has_perm('recon.review.controller') or public.has_perm('recon.finalize'))
    and status <> 'finalized');

-- refunds: request/approve
create policy rf_read on public.refunds for select to authenticated using (public.has_perm('payments.view'));
create policy rf_ins on public.refunds for insert to authenticated with check (public.has_perm('payments.refund.request'));
create policy rf_upd on public.refunds for update to authenticated using (public.has_perm('payments.refund.approve'));

-- audit: insert authenticated (server writes), select audit.view, NO update/delete
create policy al_ins on public.audit_logs for insert to authenticated with check (true);
create policy al_read on public.audit_logs for select to authenticated using (public.has_perm('audit.view'));

-- notifications: read own/audience; insert authenticated (server writes)
create policy nt_read on public.notifications for select to authenticated
  using (audience_role is null or audience_role = '' or audience_role = public.current_role() or user_id = public.current_user_id());
create policy nt_ins on public.notifications for insert to authenticated with check (true);
create policy nt_upd on public.notifications for update to authenticated
  using (user_id = public.current_user_id() or user_id is null);

-- invoices: read billing.view; write billing.manage
create policy iv_read on public.invoices for select to authenticated using (public.has_perm('billing.view'));
create policy iv_ins on public.invoices for insert to authenticated with check (public.has_perm('billing.manage'));
create policy iv_upd on public.invoices for update to authenticated
  using (public.has_perm('billing.manage')) with check (public.has_perm('billing.manage'));
create policy ii_read on public.invoice_items for select to authenticated using (public.has_perm('billing.view'));
create policy ii_ins on public.invoice_items for insert to authenticated with check (public.has_perm('billing.manage'));
create policy ii_upd on public.invoice_items for update to authenticated
  using (public.has_perm('billing.manage')) with check (public.has_perm('billing.manage'));

-- access_logs: append-only (server + ANPR writes), read access.view
create policy ac_ins on public.access_logs for insert to authenticated with check (public.has_perm('access.view'));
create policy ac_read on public.access_logs for select to authenticated using (public.has_perm('access.view'));

-- validation_codes: read validations.view; issue/revoke validations.manage; redeem path updates via server
create policy vc_read on public.validation_codes for select to authenticated using (public.has_perm('validations.view'));
create policy vc_ins on public.validation_codes for insert to authenticated with check (public.has_perm('validations.manage'));
create policy vc_upd on public.validation_codes for update to authenticated
  using (public.has_perm('validations.manage')) with check (public.has_perm('validations.manage'));

-- gate_logs: append-only, opened by exit staff, read by viewers
create policy gt_ins on public.gate_logs for insert to authenticated with check (public.has_perm('sessions.exit'));
create policy gt_read on public.gate_logs for select to authenticated using (public.has_perm('sessions.view'));
