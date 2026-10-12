import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db';
import { verifyWebhookHash } from '../billing/flutterwave';
import { reconcilePayment } from '../billing/service';

const router = Router();

// Landed page for third-party browsers after the hosted checkout redirects.
// The mobile app captures this URL (and its query params) via its web browser.
router.get('/redirect', (_req, res) => {
  res
    .status(200)
    .type('html')
    .send(
      '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding-top:3rem">' +
        '<h1>Returning to Rota...</h1><p>You can close this window and go back to the app.</p>' +
        '</body></html>'
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

const markProcessed = async (eventKey: string, poolClient?: import('pg').PoolClient) => {
  const query =
    'UPDATE webhook_events SET processed_at = CURRENT_TIMESTAMP WHERE event_key = $1 AND processed_at IS NULL';
  if (poolClient) {
    await poolClient.query(query, [eventKey]);
  } else {
    await pool.query(query, [eventKey]);
  }
};

// Flutterwave webhook receiver. Validates the `verif-hash` header, dedupes by
// event key, and settles matching PENDING payments. Must return 200 quickly.
router.post('/webhook/flutterwave', webhookLimiter, async (req, res, next) => {
  try {
    const received = typeof req.headers['verif-hash'] === 'string' ? req.headers['verif-hash'] : '';
    if (!verifyWebhookHash(received)) {
      return res
        .status(401)
        .json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid webhook hash' } });
    }

    const body = (req.body ?? {}) as {
      event?: string;
      data?: { id?: string | number; status?: string; tx_ref?: string; amount?: string | number; currency?: string };
    };
    const event = body.event ?? '';
    const data = body.data ?? {};
    const eventId = String(data.id ?? '');
    const eventKey = eventId ? `${event}:${eventId}` : `raw:${JSON.stringify(body)}`;

    const upsert = await pool.query(
      `INSERT INTO webhook_events (event_key, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_key) DO UPDATE
         SET event_type = EXCLUDED.event_type,
             payload = EXCLUDED.payload,
             received_at = CURRENT_TIMESTAMP
       RETURNING processed_at`,
      [eventKey, event, JSON.stringify(body)]
    );
    if (upsert.rows[0]?.processed_at) {
      return res.json({ success: true, data: { processed: false, reason: 'duplicate' } });
    }

    if (event !== 'charge.completed') {
      await markProcessed(eventKey);
      return res.json({ success: true, data: { processed: false, reason: event || 'unknown' } });
    }

    const txRef = typeof data.tx_ref === 'string' ? data.tx_ref : '';
    if (data.status !== 'successful' || !txRef || !eventId) {
      await markProcessed(eventKey);
      return res.json({ success: true, data: { processed: false, reason: 'not-settleable' } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const payRes = await client.query(
        `SELECT team_id FROM payment_transactions
         WHERE tx_ref = $1 AND status = $2 AND change_id IS NOT NULL`,
        [txRef, 'PENDING']
      );
      if (payRes.rows.length === 0) {
        await markProcessed(eventKey, client);
        await client.query('COMMIT');
        return res.json({ success: true, data: { processed: false, reason: 'no-pending' } });
      }
      const teamId = payRes.rows[0].team_id;

      const gateway = {
        transactionId: String(data.id),
        txRef,
        amountMajor: Number(data.amount),
        currency: typeof data.currency === 'string' ? data.currency : '',
        status: data.status,
      };

      const result = await reconcilePayment(client, teamId, txRef, gateway, new Date());
      await markProcessed(eventKey, client);
      await client.query('COMMIT');
      res.json({ success: true, data: { processed: true, outcome: result.outcome } });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

export default router;