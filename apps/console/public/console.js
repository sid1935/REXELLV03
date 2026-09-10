/**
 * ReXell organizer console.
 *
 * A thin client over the organizer API. Every call it makes is one an organizer
 * could make themselves with curl, which is deliberate: if this page can do
 * something the public API cannot, the API is incomplete.
 *
 * The key lives in localStorage and nowhere else. This page has no server of its
 * own beyond a static file host.
 */

const $ = (id) => document.getElementById(id);
const API = new URLSearchParams(location.search).get('api') ?? 'http://127.0.0.1:8080';

let key = localStorage.getItem('rexell.key') ?? '';
let events = [];
let timer;

const rupees = (paise) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function call(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.error?.message ?? `${res.status}`);
  return body;
}

// ─── tabs ────────────────────────────────────────────────────────────────────

const TABS = ['setup', 'create', 'live', 'settle'];
function show(tab) {
  for (const t of TABS) $(t).hidden = t !== tab;
  document.querySelectorAll('nav button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.tab === tab));
  });
  clearInterval(timer);
  if (tab === 'live') {
    refreshLive();
    // Polling, not websockets: an onsale dashboard that holds a socket per
    // organizer is a socket pool to run out of at exactly the wrong moment.
    timer = setInterval(refreshLive, 5_000);
  }
  if (tab === 'settle') refreshSettlement();
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

// ─── account ─────────────────────────────────────────────────────────────────

$('signupBtn').addEventListener('click', async () => {
  const name = $('orgName').value.trim();
  if (!name) return;
  try {
    const result = await call('/v1/organizers', {
      method: 'POST',
      body: JSON.stringify({ name, contactEmail: $('orgEmail').value.trim() || undefined }),
    });
    key = result.apiKey;
    localStorage.setItem('rexell.key', key);
    $('keyValue').textContent = key;
    $('keyCard').hidden = false;
    $('signupCard').hidden = true;
    await loadMe();
  } catch (e) {
    alert(e.message);
  }
});

$('useKeyBtn').addEventListener('click', () => {
  $('pasteCard').hidden = false;
  $('signupCard').hidden = true;
});

$('pasteGo').addEventListener('click', async () => {
  key = $('pasteKey').value.trim();
  localStorage.setItem('rexell.key', key);
  await loadMe();
});

async function loadMe() {
  if (!key) return;
  try {
    const me = await call('/v1/me');
    $('who').textContent = `${me.name} · ${me.organizerId}`;
    $('signupCard').hidden = true;
    $('pasteCard').hidden = true;
    $('keysCard').hidden = false;

    const keys = await call('/v1/keys');
    $('keysBody').innerHTML = keys.keys
      .map(
        (k) => `<tr>
          <td>${k.name}</td>
          <td class="mono">${k.prefix}</td>
          <td class="mono" style="font-size:11px">${k.scopes.join(' ')}</td>
          <td>${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '—'}</td>
          <td>${k.revokedAt ? '<span class="tag bad">revoked</span>' : `<button class="ghost" data-revoke="${k.keyId}">Revoke</button>`}</td>
        </tr>`,
      )
      .join('');

    document.querySelectorAll('[data-revoke]').forEach((b) =>
      b.addEventListener('click', async () => {
        await call(`/v1/keys/${b.dataset.revoke}`, { method: 'DELETE' });
        await loadMe();
      }),
    );

    await loadEvents();
  } catch (e) {
    $('who').textContent = 'key not accepted';
    $('signupCard').hidden = false;
  }
}

async function loadEvents() {
  try {
    events = (await call('/v1/events')).events;
  } catch {
    events = [];
  }
  for (const picker of [$('evPicker'), $('setPicker')]) {
    const current = picker.value;
    picker.innerHTML = events.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
    if (current) picker.value = current;
  }
}

$('evPicker').addEventListener('change', refreshLive);
$('setPicker').addEventListener('change', refreshSettlement);

// ─── create ──────────────────────────────────────────────────────────────────

function previewResale() {
  const face = Number($('evFace').value) || 0;
  const cap = Number($('rsCap').value) || 100;
  const org = Number($('rsOrg').value) || 0;
  const rights = Number($('rsRights').value) || 0;
  const ceiling = Math.floor(face * (cap / 100));
  const platform = 3;
  const seller = 100 - org - rights - platform;

  $('rsPreview').innerHTML =
    $('rsMode').value === 'bound'
      ? 'Resale off. The ticket cannot be transferred by anybody, at any price. Pair this with a face-value returns queue or your support inbox becomes one.'
      : `A ₹${face.toLocaleString('en-IN')} ticket resells for at most <b>₹${ceiling.toLocaleString('en-IN')}</b>. ` +
        `On a sale at the ceiling you receive <b>₹${Math.floor((ceiling * org) / 100).toLocaleString('en-IN')}</b>, ` +
        `the artist ₹${Math.floor((ceiling * rights) / 100).toLocaleString('en-IN')}, ` +
        `ReXell ₹${Math.floor((ceiling * platform) / 100).toLocaleString('en-IN')}, ` +
        `and the seller keeps ${seller}%.`;
}
['evFace', 'rsCap', 'rsOrg', 'rsRights', 'rsMode'].forEach((id) =>
  $(id).addEventListener('input', previewResale),
);
previewResale();

$('createBtn').addEventListener('click', async () => {
  const now = Date.now();
  const doors = now + Number($('evDoors').value) * 86_400_000;
  const ends = doors + 10 * 3_600_000;
  const eventId = `evt_${Math.random().toString(36).slice(2, 10)}`;
  const capped = $('rsMode').value === 'capped';

  const event = {
    id: eventId,
    name: $('evName').value,
    capacity: Number($('evCapacity').value),
    salesOpenAt: now,
    salesCloseAt: doors - 2 * 3_600_000,
    doorsOpenAt: doors,
    endsAt: ends,
    maxTicketsPerIdentity: Number($('evLimit').value),
    allowReentry: false,
    tiers: [
      {
        id: `${eventId}_ga`,
        eventId,
        name: 'General Admission',
        faceValue: Math.round(Number($('evFace').value) * 100),
        allocation: Number($('evAlloc').value),
        resale: {
          mode: capped ? 'capped' : 'bound',
          maxPriceBps: capped ? Math.round(Number($('rsCap').value) * 100) : 10_000,
          minPriceBps: capped ? Math.round(Number($('rsFloor').value) * 100) : 10_000,
          opensAt: now,
          closesAt: capped ? doors - 6 * 3_600_000 : doors,
          cooldownMs: Number($('rsCooldown').value) * 3_600_000,
          maxResalesPerTicket: capped ? 2 : 0,
          maxActiveListingsPerIdentity: capped ? 2 : 0,
          splits: {
            organizerBps: Math.round(Number($('rsOrg').value) * 100),
            platformBps: 300,
            rightsHolderBps: Math.round(Number($('rsRights').value) * 100),
          },
        },
      },
    ],
  };

  try {
    const created = await call('/v1/organizer/events', { method: 'POST', body: JSON.stringify({ event }) });
    $('createResult').innerHTML = `<div class="note">
      Created <code>${created.eventId}</code>.
      ${created.tiers[0].ceilingMinor ? `Resale capped at ${rupees(created.tiers[0].ceilingMinor)}.` : 'Resale off.'}
      <div class="hint" style="margin-top:8px">Policy hash <code>${created.policyHash.slice(0, 32)}…</code> — anchored on chain, so these terms cannot be quietly changed after tickets sell.</div>
    </div>`;
    await loadEvents();
  } catch (e) {
    $('createResult').innerHTML = `<div class="note warn">${e.message}</div>`;
  }
});

// ─── live ────────────────────────────────────────────────────────────────────

async function refreshLive() {
  const eventId = $('evPicker').value;
  if (!eventId) return ($('liveBody').innerHTML = '<div class="note">No events yet.</div>');

  try {
    const a = await call(`/v1/events/${eventId}/analytics`);
    const fallbackBad = a.attendance.fallbackRate > 0.015;

    $('liveBody').innerHTML = `
      <div class="stats" style="margin-bottom:16px">
        <div><b>${a.sales.sold.toLocaleString('en-IN')}</b><span>sold</span></div>
        <div><b>${pct(a.sales.sellThrough)}</b><span>sell-through</span></div>
        <div><b>${rupees(a.sales.grossMinor)}</b><span>gross</span></div>
        <div><b>${rupees(a.resale.organizerCommissionMinor)}</b><span>resale commission</span></div>
      </div>

      <div class="card">
        <h2 style="font-size:15px;margin-bottom:12px">Tiers</h2>
        <table><thead><tr><th>Tier</th><th class="n">Face</th><th class="n">Sold</th><th class="n">Held</th><th class="n">Left</th><th class="n">Gross</th></tr></thead><tbody>
        ${a.sales.tiers
          .map(
            (t) => `<tr><td>${t.name}</td><td class="n">${rupees(t.faceValueMinor)}</td>
            <td class="n">${t.sold}</td><td class="n">${t.held}</td><td class="n">${t.remaining}</td>
            <td class="n">${rupees(t.grossMinor)}</td></tr>`,
          )
          .join('')}
        </tbody></table>
      </div>

      <div class="card">
        <h2 style="font-size:15px;margin-bottom:12px">Resale</h2>
        <div class="stats">
          <div><b>${a.resale.activeListings}</b><span>listed now</span></div>
          <div><b>${a.resale.completed}</b><span>resold</span></div>
          <div><b>${rupees(a.resale.volumeMinor)}</b><span>volume</span></div>
          <div><b>${pct(a.resale.attachRate)}</b><span>attach rate</span></div>
        </div>
      </div>

      <div class="card">
        <h2 style="font-size:15px;margin-bottom:12px">At the gate</h2>
        <div class="stats">
          <div><b>${a.attendance.admitted}</b><span>admitted</span></div>
          <div><b>${pct(a.attendance.turnout)}</b><span>turnout</span></div>
          <div><b style="color:${fallbackBad ? 'var(--hot)' : 'inherit'}">${pct(a.attendance.fallbackRate)}</b><span>fallback rate</span></div>
          <div><b style="color:${a.attendance.doubleEntries ? 'var(--hot)' : 'inherit'}">${a.attendance.doubleEntries}</b><span>double entries</span></div>
        </div>
        ${fallbackBad ? '<div class="note warn" style="margin:14px 0 0">Fallback is above 1.5%. The resolution desk is becoming the queue — check lighting and camera angle at the busiest lane.</div>' : ''}
      </div>`;
  } catch (e) {
    $('liveBody').innerHTML = `<div class="note warn">${e.message}</div>`;
  }
}

// ─── settlement ──────────────────────────────────────────────────────────────

async function refreshSettlement() {
  const eventId = $('setPicker').value;
  if (!eventId) return ($('settleBody').innerHTML = '<div class="note">No events yet.</div>');

  try {
    const r = await call(`/v1/events/${eventId}/settlement/report`);
    $('settleBody').innerHTML = `
      <div class="stats" style="margin-bottom:16px">
        <div><b>${r.resales}</b><span>resales</span></div>
        <div><b>${rupees(r.totals.volumeMinor)}</b><span>volume</span></div>
        <div><b>${rupees(r.totals.organizerMinor)}</b><span>your share</span></div>
        <div><b>${r.chain.confirmed}/${r.resales}</b><span>on chain</span></div>
      </div>

      ${
        r.reconciled
          ? `<div class="note">Every line recomputes from your own policy and balances to the paisa.${
              r.chain.awaiting
                ? ` ${r.chain.awaiting} still awaiting chain confirmation, which is normal — payouts do not wait for it.`
                : ''
            }</div>`
          : `<div class="note warn"><b>${r.discrepancies.length} discrepanc${r.discrepancies.length === 1 ? 'y' : 'ies'}.</b> Do not pay out against this report. ${r.discrepancies
              .map((d) => `<code>${d.problem}</code>`)
              .join(' ')}</div>`
      }

      <div class="card">
        <table><thead><tr>
          <th>Ticket</th><th class="n">Sold for</th><th class="n">You</th><th class="n">Artist</th>
          <th class="n">ReXell</th><th class="n">Seller</th><th>Checks</th>
        </tr></thead><tbody>
        ${r.lines
          .map(
            (l) => `<tr>
              <td class="mono" style="font-size:11px">${l.ticketId.slice(0, 14)}…</td>
              <td class="n">${rupees(l.salePriceMinor)}</td>
              <td class="n">${rupees(l.organizerMinor)}</td>
              <td class="n">${rupees(l.rightsHolderMinor)}</td>
              <td class="n">${rupees(l.platformMinor)}</td>
              <td class="n">${rupees(l.sellerMinor)}</td>
              <td>
                <span class="tag ${l.recomputed ? 'ok' : 'bad'}">policy</span>
                <span class="tag ${l.balanced ? 'ok' : 'bad'}">balances</span>
                <span class="tag ${l.onChain ? 'ok' : ''}">${l.onChain ? 'on chain' : 'pending'}</span>
              </td>
            </tr>`,
          )
          .join('')}
        </tbody></table>
      </div>`;
  } catch (e) {
    $('settleBody').innerHTML = `<div class="note warn">${e.message}</div>`;
  }
}

// ─── boot ────────────────────────────────────────────────────────────────────

if (key) loadMe();
show('setup');
