import type { Pool, PoolClient } from 'pg';

type Q = Pick<Pool | PoolClient, 'query'>;
export type Decision = 'ALLOW' | 'CHALLENGE' | 'BLOCK';
export interface Reason { code: string; label: string; weight: number }
export interface Assessment { score: number; decision: Decision; reasons: Reason[] }

export interface Features {
  amountPaise: number; balancePaise: number;
  senderAgeH: number; recipientAgeH: number;
  recipientIsNew: boolean;          // no completed payment to this recipient in 90 days
  historyCount: number; historyAvgPaise: number;
  sent10m: number; distinctRecipients24h: number;
  receivedLastHourPaise: number;
  ipKnown: boolean; ipSeenBefore: boolean;
  recentAuthFailures: number;
}

/**
 * Naive-Bayes-style scoring: start from a prior log-odds of "this payment is fraudulent" and add one log-likelihood
 * ratio per signal that fires. score = 100 * sigmoid(log-odds). The weights are expert priors chosen to be explainable,
 * NOT trained on real fraud data; every decision carries the reasons that produced it.
 */
const PRIOR = Math.log(0.03 / 0.97);
const R = (code: string, label: string, weight: number): Reason => ({ code, label, weight });

export function scoreTransfer(f: Features, th: { challenge: number; block: number }): Assessment {
  const r: Reason[] = [];
  if (f.recipientIsNew) r.push(R('NEW_RECIPIENT', 'First payment to this recipient', 0.9));
  if (f.recipientAgeH < 24) r.push(R('NEW_RECIPIENT_ACCOUNT', 'Recipient account is less than a day old', 1.0));
  if (f.senderAgeH < 24) r.push(R('NEW_SENDER_ACCOUNT', 'Your account is less than a day old', 0.8));
  else if (f.senderAgeH < 168) r.push(R('YOUNG_SENDER_ACCOUNT', 'Your account is less than a week old', 0.3));

  if (f.historyCount >= 3 && f.historyAvgPaise > 0) {
    const ratio = f.amountPaise / f.historyAvgPaise;
    if (ratio >= 5) r.push(R('AMOUNT_SPIKE', 'At least 5x larger than your usual payment', 1.5));
    else if (ratio >= 3) r.push(R('AMOUNT_HIGH', 'At least 3x larger than your usual payment', 0.9));
  } else if (f.amountPaise >= 1_000_000) r.push(R('LARGE_NO_HISTORY', 'Large payment with little payment history', 0.8));

  if (f.sent10m >= 6) r.push(R('VELOCITY_EXTREME', 'Many payments in the last 10 minutes', 2.0));
  else if (f.sent10m >= 3) r.push(R('VELOCITY_HIGH', 'Several payments in the last 10 minutes', 1.0));
  if (f.distinctRecipients24h >= 5) r.push(R('FAN_OUT', 'Payments to many different people in 24 hours', 1.0));
  if (f.amountPaise >= 100_000 && f.receivedLastHourPaise >= 0.8 * f.amountPaise) r.push(R('PASS_THROUGH', 'Forwarding money received in the last hour', 0.9));
  if (f.amountPaise >= 100_000 && f.amountPaise >= 0.9 * f.balancePaise) r.push(R('DRAINS_BALANCE', 'Empties almost the whole wallet', 1.0));
  if (f.ipKnown && !f.ipSeenBefore) r.push(R('UNFAMILIAR_NETWORK', 'Signed in from a network not seen before', 1.1));
  if (f.recentAuthFailures >= 3) r.push(R('RECENT_AUTH_FAILURES', 'Several failed sign-in or PIN attempts recently', 1.2));

  const logit = PRIOR + r.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(100 / (1 + Math.exp(-logit)));
  const decision: Decision = score >= th.block ? 'BLOCK' : score >= th.challenge ? 'CHALLENGE' : 'ALLOW';
  return { score, decision, reasons: r };
}

/** Reads the signals for one prospective payment. Every query is bounded by a time window and uses an existing index. */
export async function gatherFeatures(q: Q, i: { senderId: string; receiverId: string; amountPaise: number; ip?: string }): Promise<Features> {
  const base = (await q.query(`
    SELECT sw.id AS sw, rw.id AS rw, sw.balance_paise::text AS balance,
      EXTRACT(EPOCH FROM now() - su.created_at) / 3600 AS s_age, EXTRACT(EPOCH FROM now() - ru.created_at) / 3600 AS r_age
    FROM users su JOIN wallets sw ON sw.user_id = su.id, users ru JOIN wallets rw ON rw.user_id = ru.id
    WHERE su.id = $1 AND ru.id = $2`, [i.senderId, i.receiverId])).rows[0];
  const h = (await q.query(`
    SELECT count(*) FILTER (WHERE receiver_wallet_id = $2)::int AS to_recipient, count(*)::int AS n,
      COALESCE(avg(amount_paise), 0)::float8 AS avg_amt,
      count(*) FILTER (WHERE created_at > now() - interval '10 minutes')::int AS sent_10m,
      count(DISTINCT receiver_wallet_id) FILTER (WHERE created_at > now() - interval '24 hours')::int AS d24
    FROM transactions WHERE type='TRANSFER' AND status='COMPLETED' AND sender_wallet_id = $1 AND created_at > now() - interval '90 days'`, [base.sw, base.rw])).rows[0];
  const inc = (await q.query(`SELECT COALESCE(sum(amount_paise), 0)::text AS s FROM transactions
    WHERE type='TRANSFER' AND status='COMPLETED' AND receiver_wallet_id = $1 AND created_at > now() - interval '60 minutes'`, [base.sw])).rows[0];
  const ip = (await q.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE ip = $2)::int AS same FROM audit_logs
    WHERE actor_user_id = $1 AND action = 'LOGIN_SUCCESS' AND created_at > now() - interval '30 days'`, [i.senderId, i.ip ?? ''])).rows[0];
  const fails = (await q.query(`SELECT count(*)::int AS n FROM audit_logs
    WHERE actor_user_id = $1 AND action IN ('LOGIN_FAILED','PIN_FAILED','MFA_FAILED') AND created_at > now() - interval '1 hour'`, [i.senderId])).rows[0];
  return {
    amountPaise: i.amountPaise, balancePaise: Number(base.balance), senderAgeH: Number(base.s_age), recipientAgeH: Number(base.r_age),
    recipientIsNew: h.to_recipient === 0, historyCount: h.n, historyAvgPaise: h.avg_amt, sent10m: h.sent_10m, distinctRecipients24h: h.d24,
    receivedLastHourPaise: Number(inc.s), ipKnown: !!i.ip && ip.total > 0, ipSeenBefore: ip.same > 0, recentAuthFailures: fails.n,
  };
}

export async function assessTransfer(q: Q, th: { challenge: number; block: number }, i: { senderId: string; receiverId: string; amountPaise: number; ip?: string }) {
  return scoreTransfer(await gatherFeatures(q, i), th);
}

/** Persist a final decision (a completed payment or a block). BLOCK rows enter the admin review queue. */
export async function recordRisk(q: Q, i: { userId: string; recipientId: string; amountPaise: number; a: Assessment; decision?: Decision; transactionId?: string; ip?: string }) {
  const decision = i.decision ?? i.a.decision;
  const r = await q.query(`INSERT INTO risk_events(user_id, recipient_user_id, transaction_id, amount_paise, score, decision, reasons, ip, review_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [i.userId, i.recipientId, i.transactionId ?? null, i.amountPaise, i.a.score, decision, JSON.stringify(i.a.reasons), i.ip ?? null, decision === 'BLOCK' ? 'OPEN' : 'NONE']);
  return r.rows[0].id as string;
}
