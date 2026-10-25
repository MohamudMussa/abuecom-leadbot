// Abu Ecom lead bot.
// Checks the Meta lead form(s) for new leads and posts each one to Slack
// with a one-tap WhatsApp button (number cleaned, opener pre-typed).
//
// Env:
//   META_TOKEN     Page access token with leads_retrieval
//   FORM_IDS       Comma-separated lead form IDs
//   SLACK_WEBHOOK  Slack incoming webhook URL (#leads)
//   DRY_RUN=1      Print messages instead of posting
//   TEST_LEAD=1    Post one fake lead to Slack to check the format

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const GRAPH = 'https://graph.facebook.com/v21.0';
const STATE_FILE = new URL('./state.json', import.meta.url);
const { META_TOKEN, FORM_IDS = '', SLACK_WEBHOOK, DRY_RUN, TEST_LEAD } = process.env;

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function loadState() {
  if (!existsSync(STATE_FILE)) return { since: Math.floor(Date.now() / 1000) - 3600, seen: [] };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

async function graph(path, params = {}) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  url.searchParams.set('access_token', META_TOKEN);
  const res = await fetch(url);
  const body = await res.json();
  if (body.error) throw new Error(`Meta error on ${path}: ${body.error.message}`);
  return body;
}

async function fetchLeads(formId, since) {
  const leads = [];
  let page = await graph(`/${formId}/leads`, {
    fields: 'id,created_time,field_data,ad_name,adset_name,campaign_name,form_id,is_organic',
    filtering: [{ field: 'time_created', operator: 'GREATER_THAN', value: since }],
    limit: '100',
  });
  for (;;) {
    leads.push(...(page.data || []));
    if (!page.paging?.next) break;
    page = await (await fetch(page.paging.next)).json();
  }
  return leads;
}

// Turn Meta's field_data into a flat { key: value } object.
function flatten(lead) {
  const out = {};
  for (const f of lead.field_data || []) out[f.name] = (f.values || []).join(', ');
  return out;
}

const pick = (f, ...keys) => {
  for (const k of Object.keys(f)) if (keys.some((want) => k.toLowerCase().includes(want))) return f[k];
  return '';
};

function cleanPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  return d;
}

function junkReasons({ email, phone, website, name }) {
  const r = [];
  if (/555\d{4}$/.test(phone) || /^1?\d{3}5550\d{3}$/.test(phone)) r.push('fake-looking phone');
  if (phone && phone.length < 9) r.push('phone too short');
  if (/^(test|asdf|xx|aa|qq)/i.test(email) || /@(test|example|edd)\./i.test(email) || /([a-z])\1{3,}/i.test(email.split('@')[0] || '')) r.push('fake-looking email');
  if (website && !/\.[a-z]{2,}/i.test(website)) r.push('no real website');
  if (/^(bob|test|asdf|na|n\/a)$/i.test(name.trim())) r.push('fake-looking name');
  return r;
}

function buildMessage(lead) {
  const f = flatten(lead);
  const name = pick(f, 'full_name', 'name') || 'there';
  const first = name.trim().split(/\s+/)[0];
  const email = pick(f, 'email');
  const phone = cleanPhone(pick(f, 'phone'));
  const website = pick(f, 'website', 'store', 'url', 'site');
  const revenue = pick(f, 'revenue', 'month', 'sales');
  const known = new Set(['full_name', 'email', 'phone_number']);
  const answers = Object.entries(f)
    .filter(([k]) => !known.has(k))
    .map(([k, v]) => `• ${k.replace(/_/g, ' ').replace(/\?$/, '')}: *${v.replace(/_/g, ' ')}*`)
    .join('\n');

  const site = website ? website.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'your store';
  const opener = `Salaam ${first}, it's Mussa from Abu Ecom. You just asked about getting your email done for ${site}. Have you got 2 mins for a quick call today?`;
  const wa = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(opener)}` : null;
  const junk = junkReasons({ email, phone, website, name });
  const big = /(20k|50k|100k|150k|\$5k\+|5k\+)/i.test(revenue);
  const head = junk.length ? ':warning: Probably junk' : big ? ':fire: Hot lead' : ':crescent_moon: New lead';

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${head.replace(/:[a-z_]+: /, '')}: ${name}`.slice(0, 150) } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [

          `*${name}*${website ? `  ·  <${/^https?:/.test(website) ? website : 'https://' + website}|${site}>` : ''}`,
          `:phone: ${phone ? '+' + phone : 'no phone'}   :email: ${email || 'no email'}`,
          answers,
          junk.length ? `_Junk check: ${junk.join(', ')}_` : '',
        ].filter(Boolean).join('\n'),
      },
    },
  ];
  const buttons = [];
  if (wa) buttons.push({ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'WhatsApp them now' }, url: wa });
  if (email) buttons.push({ type: 'button', text: { type: 'plain_text', text: 'Email' }, url: `mailto:${email}` });
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons });
  const src = [lead.campaign_name, lead.adset_name, lead.ad_name].filter(Boolean).join(' › ');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${src || 'Lead form'}  ·  ${new Date(lead.created_time).toUTCString()}` }] });

  return { text: `${head} ${name} ${phone ? '+' + phone : ''}`, blocks };
}

async function postSlack(msg) {
  if (DRY_RUN) return console.log(JSON.stringify(msg, null, 2));
  const res = await fetch(SLACK_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg) });
  if (!res.ok) throw new Error(`Slack error ${res.status}: ${await res.text()}`);
}

async function main() {
  if (TEST_LEAD) {
    await postSlack(buildMessage({
      created_time: new Date().toISOString(),
      campaign_name: 'TEST', ad_name: 'test message, ignore',
      field_data: [
        { name: 'full_name', values: ['Test Lead'] },
        { name: 'email', values: ['mussa@abuecom.com'] },
        { name: 'phone_number', values: ['p:+447700900123'] },
        { name: 'website', values: ['abuecom.com'] },
        { name: 'monthly_revenue', values: ['$5k+_/month'] },
      ],
    }));
    return console.log('Test lead posted.');
  }

  if (!META_TOKEN || !SLACK_WEBHOOK || !FORM_IDS) throw new Error('Missing META_TOKEN, SLACK_WEBHOOK or FORM_IDS');
  const state = loadState();
  const seen = new Set(state.seen);
  let newest = state.since;
  const fresh = [];

  for (const formId of FORM_IDS.split(',').map((s) => s.trim()).filter(Boolean)) {
    for (const lead of await fetchLeads(formId, state.since - 600)) {
      const t = Math.floor(new Date(lead.created_time).getTime() / 1000);
      newest = Math.max(newest, t);
      if (!seen.has(hash(lead.id))) fresh.push(lead);
    }
  }

  fresh.sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
  for (const lead of fresh) {
    await postSlack(buildMessage(lead));
    seen.add(hash(lead.id));
  }

  const next = { since: newest, seen: [...seen].slice(-300) };
  if (!DRY_RUN) writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`${fresh.length} new lead(s) posted.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
