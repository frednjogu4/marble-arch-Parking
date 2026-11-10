-- =====================================================================
-- Marble Arch Parking — FRESH PROJECT RESET (destructive!)
-- Run ONLY on a project that holds nothing you need to keep.
-- Drops all 30 parking tables (CASCADE removes dependent FKs/policies),
-- so that supabase/migrations/001_init.sql can be re-run cleanly from zero.
-- Safe to run multiple times (IF EXISTS). Functions need no drop:
-- 001_init.sql defines them all with CREATE OR REPLACE.
-- =====================================================================

drop table if exists
  public.access_logs,
  public.app_users,
  public.audit_logs,
  public.complimentary_authorizations,
  public.customers,
  public.daily_reconciliations,
  public.discounts,
  public.gate_logs,
  public.hotel_settings,
  public.invoice_items,
  public.invoices,
  public.monthly_packages,
  public.monthly_subscriptions,
  public.notifications,
  public.parking_categories,
  public.parking_sessions,
  public.parking_spaces,
  public.payment_transactions,
  public.payments,
  public.permissions,
  public.promotions,
  public.refunds,
  public.role_permissions,
  public.roles,
  public.shift_transactions,
  public.shifts,
  public.subscription_payments,
  public.tickets,
  public.users,
  public.validation_codes,
  public.vehicles
cascade;

-- Confirm the wipe: expect zero rows.
select tablename from pg_tables
where schemaname = 'public'
  and tablename <> 'spatial_ref_sys'
order by 1;
