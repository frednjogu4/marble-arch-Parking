export interface User {
  id: number; full_name: string; username: string; email: string; phone: string;
  role_id: number; role_name: string; active: number; must_change_password: number;
  created_at: string; permissions?: string[];
}

export interface HotelSettings {
  id: number; hotel_name: string; logo_data: string; address: string; phones: string;
  email: string; website: string; registration_details: string; parking_department: string;
  parking_location: string; total_spaces: number; daily_rate: number; hourly_enabled: number;
  hourly_rate: number; grace_period_minutes: number; currency: string; receipt_header: string; receipt_footer: string;
  lost_ticket_fee: number;
  terms: string; social_facebook: string; social_twitter: string; social_instagram: string;
}

export interface Space {
  id: number; code: string; zone: string; space_type: string; status: string;
  current_session_id: number | null; notes: string;
  ticket_no?: string; registration?: string; customer_name?: string; entry_time?: string;
  category_code?: string; category_name?: string; category_kind?: string;
}

export interface Occupancy {
  total: number; occupied: number; available: number; reserved: number; out_of_service: number;
  paid: number; complimentary: number; monthly: number; active_sessions: number;
}

export interface Category { id: number; code: string; name: string; kind: string; description: string; active: number; }
export interface RateRow extends Category {
  hourly_rate: number; daily_rate: number; max_charge: number | null; grace_minutes: number;
  overridden: { hourly: boolean; daily: boolean; max: boolean; grace: boolean };
}
export interface InvoiceItem { id?: number; description: string; quantity: number; unit_price: number; amount: number }
export interface Invoice {
  id: number; invoice_no: string; customer_name: string; company: string; phone: string; email: string;
  registration: string; issue_date: string; due_date: string; subtotal: number; discount_amount: number;
  total: number; amount_paid: number; balance: number; status: string; display_status: string;
  overdue: boolean; notes: string; items?: InvoiceItem[];
}

export interface Session {
  id: number; ticket_no: string; vehicle_id: number; registration: string;
  customer_name: string; phone: string; category_id: number; monthly_subscription_id: number | null;
  space_id: number | null; entry_time: string; exit_time: string | null; status: string;
  base_amount: number; discount_amount: number; amount_paid: number; payment_status: string;
  entry_user_id: number; exit_user_id: number | null; notes: string;
  category_code?: string; category_name?: string; category_kind?: string;
  space_code?: string; space_zone?: string; entry_username?: string;
  payments?: Payment[]; discounts?: Discount[]; complimentary?: any[];
}

export interface Quote {
  session_id: number; ticket_no: string; registration: string; entry_time: string;
  minutes: number; hours: number; days: number; rate: number;
  base: number; base_reason: string; discount: number; paid: number; due: number;
  monthly_covered: boolean; monthly_subscription_id: number | null;
  category: { code: string; name: string; kind: string };
  pending_discounts: number;
}

export interface Payment {
  id: number; session_id: number | null; subscription_id: number | null; amount: number;
  method: string; reference: string; verification_status: string; terminal: string;
  shift_id: number | null; received_by: number; received_by_name?: string;
  paid_at: string; notes: string; ticket_no?: string; registration?: string;
}

export interface Shift {
  id: number; user_id: number; station: string; opened_at: string; opening_cash: number;
  status: string; closed_at: string | null; expected_cash: number; actual_cash: number | null;
  expected_mpesa: number; actual_mpesa: number | null; expected_card: number; actual_card: number | null;
  variance_note: string; reviewed_by: number | null; reviewed_at: string | null;
  username?: string; full_name?: string;
}

export interface Subscription {
  id: number; customer_name: string; company: string; phone: string; email: string;
  registration: string; vehicle_type: string; package_id: number; package_name?: string;
  start_date: string; expiry_date: string; amount: number; payment_method: string;
  payment_reference: string; status: string; days_remaining?: number; expired?: boolean;
}

export interface MPackage {
  id: number; name: string; price: number; validity_days: number; reserved_space: number;
  vehicle_limit: number; benefits: string; active: number;
}

export interface Discount {
  id: number; session_id: number; promotion_id: number | null; original_amount: number;
  discount_amount: number; final_amount: number; reason: string; applied_by: number;
  approved_by: number | null; status: string; created_at: string; decided_at: string | null;
  ticket_no?: string; registration?: string; applied_by_name?: string; approved_by_name?: string;
  promotion_name?: string;
}

export interface Page<T> { data: T[]; page: number; pageSize: number; total: number; totalPages: number; }
