import { apiClient } from './client';
import { randomUUID } from 'expo-crypto';
import { PaymentAttempts } from '@rota/shared';
import { authStorage } from '../storage/authStorage';
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
  checkoutUrl:string|null;
  processing?:boolean;
}

export interface VerifyOutcome {
  outcome:string;
  payment?:{status:string};
}

export const fetchBillingSummary = async (teamId: string): Promise<BillingSummaryView> => {
  const res = await apiClient.request<BillingSummaryView>(`/teams/${teamId}/subscription`);
  return dataOrThrow(res);
};

export const fetchPlans = async (teamId: string): Promise<SubscriptionPlan[]> => {
  const res = await apiClient.request<SubscriptionPlan[]>(`/teams/${teamId}/subscription/plans`);
  return dataOrThrow(res);
};

const attempts=new PaymentAttempts(authStorage,randomUUID);
const attemptScope=async(teamId:string,operation:string)=>`${await authStorage.getItemAsync('userId')}:${teamId}:${operation}`;
export const finishPaymentAttempts=async(teamId:string,reference?:string)=>{
  if(!reference)return;
  await Promise.all(['checkout','seats','renew'].map(async operation=>attempts.finish(await attemptScope(teamId,operation),reference)));
};
const requestPayment=async(teamId:string,operation:string,input:unknown):Promise<ChangePaymentResult>=>{
  const scope=await attemptScope(teamId,operation);
  return attempts.execute(scope,input,async key=>{
    const res=await apiClient.request<ChangePaymentResult>(`/teams/${teamId}/subscription/${operation}`,{
      method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input),
    });
    const data=dataOrThrow(res);
    if(data.payment)await attempts.associate(scope,key,data.payment.txRef);
    if(!data.payment&&!data.processing) await attempts.finish(scope);
    return data;
  });
};
export const createCheckout=(teamId:string,input:{planCode:string;seats?:number;returnUrl?:string})=>requestPayment(teamId,'checkout',input);
export const changeSeats=(teamId:string,input:number|{seats:number;returnUrl?:string})=>requestPayment(teamId,'seats',typeof input==='number'?{seats:input}:input);
export const renewSubscription=(teamId:string,input?:{returnUrl?:string})=>requestPayment(teamId,'renew',input??{});

export const verifyPayment = async (
  teamId: string,
  txRef: string,
  transactionId: string
): Promise<VerifyOutcome> => {
  const res = await apiClient.request<VerifyOutcome>(`/teams/${teamId}/subscription/verify`, {
    method: 'POST',
    body: JSON.stringify({ txRef, transactionId }),
  });
  const result=dataOrThrow(res);
  if(result.outcome==='SUCCESS'||result.payment?.status==='SUCCESSFUL'||result.payment?.status==='FAILED')await finishPaymentAttempts(teamId,txRef);
  return result;
};

export const fetchPaymentStatus = async (
  teamId: string,
  txRef: string
): Promise<PaymentTransaction> => {
  const res = await apiClient.request<PaymentTransaction>(
    `/teams/${teamId}/subscription/payments/${encodeURIComponent(txRef)}`
  );
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