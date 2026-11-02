import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db';
import { verifyWebhookHash } from '../billing/flutterwave';
import { enqueueOutbox } from '../services/outbox';
import { z } from 'zod';

const router = Router();

// Landed page for third-party browsers after the hosted checkout redirects.
// The mobile app captures this URL (and its query params) via its web browser.
router.get('/redirect', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const txRef = typeof req.query.tx_ref === 'string' ? req.query.tx_ref : '';
  const transactionId = typeof req.query.transaction_id === 'string' ? req.query.transaction_id : '';
  const rawReturnUrl = typeof req.query.return_url === 'string' ? req.query.return_url : '';

  let baseTarget = 'rota://billing/redirect';
  if (
    rawReturnUrl.startsWith('rota://') ||
    rawReturnUrl.startsWith('exp://') ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(rawReturnUrl)
  ) {
    baseTarget = rawReturnUrl;
  }

  let targetUrl: string;
  try {
    const urlObj = new URL(baseTarget);
    if (status) urlObj.searchParams.set('status', status);
    if (txRef) urlObj.searchParams.set('tx_ref', txRef);
    if (transactionId) urlObj.searchParams.set('transaction_id', transactionId);
    targetUrl = urlObj.toString();
  } catch {
    targetUrl = `rota://billing/redirect?status=${encodeURIComponent(status)}&tx_ref=${encodeURIComponent(txRef)}&transaction_id=${encodeURIComponent(transactionId)}`;
  }

  const safeTargetUrl = targetUrl.replace(/"/g, '&quot;');
  const jsonTargetUrl = JSON.stringify(targetUrl);

  res
    .status(200)
    .type('html')
    .send(
      '<!doctype html>' +
        '<html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Returning to Rota...</title>' +
        `<meta http-equiv="refresh" content="0;url=${safeTargetUrl}">` +
        `<script>window.location.replace(${jsonTargetUrl});</script>` +
        '</head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-align:center;padding:3rem 1rem;background:#f9fafb;color:#111827">' +
        '<div style="max-width:400px;margin:0 auto;background:#fff;padding:2rem;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)">' +
        '<h2 style="margin-top:0">Returning to Rota...</h2>' +
        '<p style="color:#4b5563;font-size:14px">If you are not automatically redirected, please click the button below to return to the app.</p>' +
        `<a href="${safeTargetUrl}" style="display:inline-block;margin-top:1rem;padding:12px 24px;background:#111827;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Open Rota App</a>` +
        '</div></body></html>'
    );
});

const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: {
    success: false,
    error: { code: 'TOO_MANY_REQUESTS', message: 'Try again later' },
  },
});

const WebhookSchema = z.object({event:z.string().min(1).max(100),data:z.object({id:z.union([z.string().min(1).max(100),z.number().int().nonnegative()]),tx_ref:z.string().max(200).optional()}).passthrough()}).passthrough();
// Authenticate and durably accept only. Provider verification/settlement happens in a worker.
router.post('/webhook/flutterwave',webhookLimiter,async(req,res,next)=>{
  try {
    const received=typeof req.headers['verif-hash']==='string'?req.headers['verif-hash']:'';
    if(!verifyWebhookHash(received))return res.status(401).json({success:false,error:{code:'UNAUTHORIZED',message:'Invalid webhook hash'}});
    const body=WebhookSchema.parse(req.body); const eventKey=body.event+':'+String(body.data.id);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted=await client.query('INSERT INTO webhook_events(event_key,event_type,payload) VALUES($1,$2,$3) ON CONFLICT(event_key) DO NOTHING RETURNING event_key',[eventKey,body.event,JSON.stringify(body)]);
      if(inserted.rows.length)await enqueueOutbox(client,{key:'webhook:'+eventKey,kind:'PAYMENT_WEBHOOK',payload:{eventKey}});
      await client.query('COMMIT');
      res.json({success:true,data:{accepted:true,processed:false,reason:inserted.rows.length?'queued':'duplicate'}});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch(error){next(error);}
});
export default router;
