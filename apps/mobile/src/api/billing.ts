import { apiClient } from './client';
import { dataOrThrow, toQuery } from './ensure';
import {
  BillingInvoice,
  BillingSummary,
  PaginatedResponse,
  PaymentTransaction,
  SubscriptionChange,
  SubscriptionPlan,
} from '@rota/shared';

export interface BillingSummaryView extends BillingSummary {
  billingEnabled: boolean;
}

export interface ChangePaymentResult {
  change: SubscriptionChange;
  payment: PaymentTransaction | null;
  checkoutUrl: string | null;
}

export interface VerifyOutcome {
  outcome: string;
}

export const fetchBillingSummary = async (teamId: string): Promise<BillingSummaryView> => {
  const res = await apiClient.request<BillingSummaryView>(`/teams/${teamId}/subscription`);
  return dataOrThrow(res);
};

export const fetchPlans = async (teamId: string): Promise<SubscriptionPlan[]> => {
  const res = await apiClient.request<SubscriptionPlan[]>(`/teams/${teamId}/subscription/plans`);
  return dataOrThrow(res);
};

export const createCheckout = async (
  teamId: string,
  input: { planCode: string; seats?: number }
): Promise<ChangePaymentResult> => {
  const res = await apiClient.request<ChangePaymentResult>(`/teams/${teamId}/subscription/checkout`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return dataOrThrow(res);
};

export const changeSeats = async (teamId: string, seats: number): Promise<ChangePaymentResult> => {
  const res = await apiClient.request<ChangePaymentResult>(`/teams/${teamId}/subscription/seats`, {
    method: 'POST',
    body: JSON.stringify({ seats }),
  });
  return dataOrThrow(res);
};

export const renewSubscription = async (teamId: string): Promise<ChangePaymentResult> => {
  const res = await apiClient.request<ChangePaymentResult>(`/teams/${teamId}/subscription/renew`, {
    method: 'POST',
  });
  return dataOrThrow(res);
};

export const verifyPayment = async (
  teamId: string,
  txRef: string,
  transactionId: string
): Promise<VerifyOutcome> => {
  const res = await apiClient.request<VerifyOutcome>(`/teams/${teamId}/subscription/verify`, {
    method: 'POST',
    body: JSON.stringify({ txRef, transactionId }),
  });
  return dataOrThrow(res);
};

export const fetchChanges = async (
  teamId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<PaginatedResponse<SubscriptionChange>> => {
  const res = await apiClient.request<PaginatedResponse<SubscriptionChange>>(
    `/teams/${teamId}/subscription/changes${toQuery({ limit: options.limit ?? 20, cursor: options.cursor })}`
  );
  return dataOrThrow(res);
};

export const fetchInvoices = async (
  teamId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<PaginatedResponse<BillingInvoice>> => {
  const res = await apiClient.request<PaginatedResponse<BillingInvoice>>(
    `/teams/${teamId}/subscription/billing${toQuery({ limit: options.limit ?? 20, cursor: options.cursor })}`
  );
  return dataOrThrow(res);
};