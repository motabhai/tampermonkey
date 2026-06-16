// ==UserScript==
// @name                FortiCare OPS Ticket Status
// @description         Matches [OP######] in FortiCare ticket titles and shows the linked ops.fortisase.com (Zendesk) request: status badge + activity-age chip. One badge per OPS id (handles SLA-Monitor row cloning). Refresh-on-load, per-badge + bulk refresh.
// @version             107
// @namespace           https://userscripts.frval.fortinet-emea.com/
// @author              peisenberg@fortinet.com
// @grant               GM_xmlhttpRequest
// @grant               GM_getValue
// @grant               GM_setValue
// @grant               GM_deleteValue
// @grant               GM_listValues
// @grant               GM_addStyle
// @connect             ops.fortisase.com
// @include             https://forticare.fortinet.com/CustomerSupport/SupportTeam/MyUnclosedTickets.aspx
// @include             https://forticare.fortinet.com/CustomerSupport/SupportTeam/myunclosedTickets.aspx
// @include             https://forticare.fortinet.com/CustomerSupport/SupportTeam/InqueueTickets.aspx
// @include             https://forticare.fortinet.com/CustomerSupport/SupportTeam/SLAMonitor.aspx*
// @include             https://forticare.fortinet.com/CustomerSupport/SupportTeam/TicketsQueryList.aspx
// @include             https://forticare.fortinet.com/CustomerSupport/SupportTeam/SearchTickets.aspx*
// @include             https://forticare.fortinet.com/CustomerSupport/default.aspx*
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================================
    // CONFIG
    // =========================================================================
    var OPS = {
        idPattern: '\\[\\s*OPS?\\s*[-#]?\\s*(\\d{3,})\\s*\\]', // "[OP510035]" -> 510035

        base: 'https://ops.fortisase.com',
        apiUrl:  function (id) { return this.base + '/api/v2/requests/' + id + '.json'; },
        pageUrl: function (id) { return this.base + '/hc/en-us/requests/' + id; },

        cacheKey: 'ops_',
        cacheVersion: 3,
        cacheMins: 60,
        refreshOnLoad: true,
        maxParallel: 4,
        reqTimeoutMs: 15000,

        activityBuckets: [
            { maxH: 1,        bg: '#22c55e', fg: '#000' },
            { maxH: 8,        bg: '#84cc16', fg: '#000' },
            { maxH: 24,       bg: '#eab308', fg: '#000' },
            { maxH: 72,       bg: '#f97316', fg: '#fff' },
            { maxH: Infinity, bg: '#ef4444', fg: '#fff' }
        ]
    };

    var DISPLAY_MAP = {
        'new': 'open', 'open': 'open', 'hold': 'open', 'on-hold': 'open',
        'pending': 'pending', 'solved': 'solved', 'closed': 'closed'
    };
    var STATUS_STYLE = {
        'open':    { label: 'OPEN',     bg: '#ef4444', fg: '#fff' },
        'pending': { label: 'AWAITING', bg: '#f59e0b', fg: '#000' },
        'solved':  { label: 'SOLVED',   bg: '#22c55e', fg: '#000' },
        'closed':  { label: 'CLOSED',   bg: '#16a34a', fg: '#fff' },
        '_unknown':{ label: '?',        bg: '#9ca3af', fg: '#000' },
        '_error':  { label: 'ERR',      bg: '#a855f7', fg: '#fff' }
    };

    // =========================================================================
    // STYLES
    // =========================================================================
    var css =
        '.ops-badge{display:inline-flex;align-items:center;margin-left:6px;border-radius:4px;' +
        'overflow:hidden;vertical-align:middle;white-space:nowrap;background:#e5e7eb;' +
        'font:700 11px/1.5 Segoe UI,Arial,sans-serif;}' +
        '.ops-badge .ops-refresh{padding:1px 5px;cursor:pointer;color:#374151;opacity:.8;user-select:none;}' +
        '.ops-badge .ops-refresh:hover{opacity:1;}' +
        '.ops-badge.spin .ops-refresh{animation:opsspin .8s linear infinite;}' +
        '@keyframes opsspin{to{transform:rotate(360deg);}}' +
        '.ops-badge .ops-link{padding:1px 6px;color:#374151;text-decoration:none;}' +
        '.ops-badge .ops-age{padding:1px 6px;border-left:1px solid rgba(0,0,0,.18);}' +
        '#ops-refresh-all{position:fixed;top:8px;right:10px;z-index:99999;cursor:pointer;' +
        'background:#1f2937;color:#fff;border:none;border-radius:5px;padding:5px 10px;' +
        'font:700 12px Segoe UI,Arial,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3);}' +
        '#ops-refresh-all:hover{background:#374151;}';
    if (typeof GM_addStyle === 'function') { GM_addStyle(css); }
    else {
        var s = document.createElement('style'); s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }

    // =========================================================================
    // CACHE
    // =========================================================================
    function cacheRead(id) {
        try {
            var raw = GM_getValue(OPS.cacheKey + id, '');
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (o.v !== OPS.cacheVersion) return null;
            if (Date.now() - o.t > OPS.cacheMins * 60000) return null;
            return o;
        } catch (e) { return null; }
    }
    function cacheWrite(id, d) {
        try {
            GM_setValue(OPS.cacheKey + id, JSON.stringify({
                v: OPS.cacheVersion, t: Date.now(),
                status: d.status, created: d.created || null, updated: d.updated || null
            }));
        } catch (e) {}
    }
    function cacheDelete(id) { try { GM_deleteValue(OPS.cacheKey + id); } catch (e) {} }
    function cacheClearExpired() {
        try {
            var keys = (typeof GM_listValues === 'function') ? GM_listValues() : [];
            keys.forEach(function (k) {
                if (k.indexOf(OPS.cacheKey) !== 0) return;
                try {
                    var o = JSON.parse(GM_getValue(k, ''));
                    if (!o || o.v !== OPS.cacheVersion ||
                        Date.now() - o.t > OPS.cacheMins * 60000) { GM_deleteValue(k); }
                } catch (e) { GM_deleteValue(k); }
            });
        } catch (e) {}
    }

    // =========================================================================
    // FETCH
    // =========================================================================
    function fetchStatus(id, cb) {
        GM_xmlhttpRequest({
            method: 'GET', url: OPS.apiUrl(id), timeout: OPS.reqTimeoutMs,
            headers: { 'Accept': 'application/json' },
            onload: function (r) {
                var d = parseApi(r);
                if (d) { cb(d); } else { fetchStatusHtml(id, cb); }
            },
            onerror: function () { fetchStatusHtml(id, cb); },
            ontimeout: function () { fetchStatusHtml(id, cb); }
        });
    }
    function parseApi(r) {
        if (!r || r.status !== 200) return null;
        try {
            var rq = (JSON.parse(r.responseText) || {}).request;
            if (!rq || !rq.status) return null;
            return { status: String(rq.status).toLowerCase(),
                     created: rq.created_at || null, updated: rq.updated_at || null };
        } catch (e) { return null; }
    }
    function fetchStatusHtml(id, cb) {
        GM_xmlhttpRequest({
            method: 'GET', url: OPS.pageUrl(id), timeout: OPS.reqTimeoutMs,
            onload: function (r) { cb(parseHtml(r) || { status: '_error' }); },
            onerror: function () { cb({ status: '_error' }); },
            ontimeout: function () { cb({ status: '_error' }); }
        });
    }
    function parseHtml(r) {
        if (!r || r.status !== 200 || !r.responseText) return null;
        var html = r.responseText;
        if (/users\/sign_in|please sign in/i.test(html) && !/"status"/i.test(html)) return null;
        var status = null;
        var jm = html.match(/"status"\s*:\s*"(new|open|pending|hold|on-?hold|solved|closed)"/i);
        if (jm) { status = jm[1].toLowerCase().replace(/on ?hold/, 'on-hold'); }
        else {
            try {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var el = doc.querySelector('.request-status, .status-label, [class*="request_status"], [data-status]');
                if (el) {
                    var t = ((el.getAttribute && el.getAttribute('data-status')) || el.textContent || '').toLowerCase();
                    var em = t.match(/\b(new|open|pending|on-?hold|solved|closed|awaiting)\b/);
                    if (em) status = (em[1] === 'awaiting') ? 'pending' : em[1].replace(/on ?hold/, 'on-hold');
                }
            } catch (e) {}
        }
        if (!status) return null;
        var c = html.match(/"created_at"\s*:\s*"([^"]+)"/);
        var u = html.match(/"updated_at"\s*:\s*"([^"]+)"/);
        return { status: status, created: c ? c[1] : null, updated: u ? u[1] : null };
    }

    // =========================================================================
    // TIME HELPERS
    // =========================================================================
    function relTime(ms) {
        var s = Math.max(0, Math.floor(ms / 1000));
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60); if (m < 60) return m + 'm';
        var h = Math.floor(m / 60); if (h < 48) return h + 'h';
        return Math.floor(h / 24) + 'd';
    }
    function activityColour(idleMs) {
        var h = idleMs / 3600000;
        for (var i = 0; i < OPS.activityBuckets.length; i++) {
            if (h <= OPS.activityBuckets[i].maxH) return OPS.activityBuckets[i];
        }
        return OPS.activityBuckets[OPS.activityBuckets.length - 1];
    }

    // =========================================================================
    // RENDER
    // =========================================================================
    function badgeEl(id) {
        var span = document.createElement('span');
        span.className = 'ops-badge loading ops-badge-' + id;
        span.setAttribute('data-ops-id', id);
        span.innerHTML =
            '<span class="ops-refresh" title="Refresh this OPS status">\u21BB</span>' +
            '<a class="ops-link" href="' + OPS.pageUrl(id) +
            '" target="_blank" rel="noopener">OP' + id + '\u2026</a>' +
            '<span class="ops-age" style="display:none"></span>';
        span.querySelector('.ops-refresh').addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation(); forceRefresh(id, span);
        });
        return span;
    }
    function paint(span, d, fetchedTs) {
        var id = span.getAttribute('data-ops-id');
        var raw = d.status;
        var key = (raw && raw[0] === '_') ? raw : (DISPLAY_MAP[raw] || '_unknown');
        var st = STATUS_STYLE[key] || STATUS_STYLE._unknown;
        span.classList.remove('loading', 'spin');
        var link = span.querySelector('.ops-link');
        link.style.background = st.bg; link.style.color = st.fg;
        link.textContent = 'OP' + id + ' \u00B7 ' + st.label;
        var tip = ['OPS ' + id + ' \u2014 ' +
            (raw[0] === '_' ? 'status unavailable' : st.label.toLowerCase() + ' (raw: ' + raw + ')')];
        var ageEl = span.querySelector('.ops-age');
        var upd = d.updated ? new Date(d.updated) : null;
        if (upd && !isNaN(upd.getTime())) {
            var idle = Date.now() - upd.getTime();
            var ac = activityColour(idle);
            ageEl.style.display = '';
            ageEl.style.background = ac.bg; ageEl.style.color = ac.fg;
            ageEl.textContent = relTime(idle);
            tip.push('Last activity: ' + upd.toLocaleString() + ' (' + relTime(idle) + ' ago)');
        } else { ageEl.style.display = 'none'; }
        var crt = d.created ? new Date(d.created) : null;
        if (crt && !isNaN(crt.getTime())) {
            tip.push('Created: ' + crt.toLocaleString() + ' (' + relTime(Date.now() - crt.getTime()) + ' ago)');
        }
        if (fetchedTs) tip.push('fetched ' + relTime(Date.now() - fetchedTs) + ' ago');
        tip.push('click \u21BB to refresh');
        span.title = tip.join('  \u2022  ');
    }
    function setLoading(span) {
        span.classList.add('loading', 'spin');
        var link = span.querySelector('.ops-link');
        if (link) { link.style.background = ''; link.style.color = ''; link.textContent = 'OP' + span.getAttribute('data-ops-id') + '\u2026'; }
        var ageEl = span.querySelector('.ops-age'); if (ageEl) ageEl.style.display = 'none';
    }

    var forceNextResolve = false;
    function resolve(id, span) {
        if (!forceNextResolve) {
            var cached = cacheRead(id);
            if (cached) { paint(span, cached, cached.t); return; }
        }
        queue.push({ id: id, span: span }); pump();
    }
    function forceRefresh(id, span) {
        cacheDelete(id); setLoading(span);
        queue.push({ id: id, span: span }); pump();
    }
    var queue = [], active = 0;
    function pump() {
        while (active < OPS.maxParallel && queue.length) {
            var job = queue.shift(); active++;
            (function (job) {
                fetchStatus(job.id, function (d) {
                    var ts = Date.now();
                    if (d.status && d.status[0] !== '_') cacheWrite(job.id, d);
                    paint(job.span, d, ts);
                    active--; pump();
                });
            })(job);
        }
    }

    // =========================================================================
    // SCAN + RECONCILE  -- exactly one live badge per OPS id, in a visible cell.
    // This neutralises the SLA-Monitor row cloning (Regular -> Important table)
    // that previously produced duplicate badges.
    // =========================================================================
    var live = {}; // id -> live badge span we created

    function extractIds(text) {
        var re = new RegExp(OPS.idPattern, 'gi'); var ids = {}, m;
        while ((m = re.exec(text)) !== null) { ids[m[1]] = true; }
        return Object.keys(ids);
    }
    function isVisible(el) { return !!(el && el.offsetParent !== null); }

    function reconcileId(id, hostCell) {
        var cur = live[id];
        // Remove every badge for this id that is NOT our current live one (clones).
        document.querySelectorAll('.ops-badge-' + id).forEach(function (b) {
            if (b !== cur) b.remove();
        });
        // If our current badge is still attached and visible, we're done.
        if (cur && document.contains(cur) && isVisible(cur)) return;
        // Otherwise drop it (e.g. it landed in a hidden table) and re-home.
        if (cur) { cur.remove(); delete live[id]; }
        if (!hostCell || !isVisible(hostCell)) return;
        var span = badgeEl(id);
        hostCell.appendChild(span);
        live[id] = span;
        resolve(id, span);
    }

    // A cell only counts as a host if it sits in a real ticket row, i.e. its
    // row contains a ticket-number link (...?TID=...). This keeps badges inline
    // in the title cell and ignores summaries / search-page echoes / empty
    // helper tables that also contain the [OP..] text.
    function rowHasTicketLink(cell) {
        var tr = cell.closest && cell.closest('tr');
        return !!(tr && tr.querySelector('a[href*="TID="]'));
    }
    // A leaf cell holds the title text directly; wrapper cells that merely
    // contain the whole results table (and thus all the [OP..] text) are
    // rejected so the badge lands in the title cell, not after the table.
    function isLeafCell(cell) {
        return !cell.querySelector('td, table');
    }

    function scanScope() {
        var firstCell = {}; // id -> { cell, inRow }

        document.querySelectorAll('td').forEach(function (cell) {
            if (!isVisible(cell) || !isLeafCell(cell)) return;
            var ids = extractIds(cell.textContent || '');
            if (!ids.length) return;
            var inRow = rowHasTicketLink(cell);
            ids.forEach(function (id) {
                var cur = firstCell[id];
                // First match wins; but a real ticket-row cell upgrades over a
                // non-row leaf cell. TID links are produced by the main FortiCare
                // script, so when it is disabled we simply fall back to the first
                // visible leaf title cell -- the script still works standalone.
                if (!cur) firstCell[id] = { cell: cell, inRow: inRow };
                else if (!cur.inRow && inRow) firstCell[id] = { cell: cell, inRow: inRow };
            });
        });

        // Fallback for the single-ticket detail page (title in a header element).
        ['ctl00_MainContent_L_Title', 'ctl00_MainContent_L_Info'].forEach(function (eid) {
            var el = document.getElementById(eid);
            if (!el || !isVisible(el)) return;
            extractIds(el.textContent || '').forEach(function (id) {
                if (!firstCell[id]) firstCell[id] = { cell: el, inRow: false };
            });
        });

        Object.keys(firstCell).forEach(function (id) { reconcileId(id, firstCell[id].cell); });
        // Forget badges that fell out of the DOM entirely.
        Object.keys(live).forEach(function (id) {
            if (!live[id] || !document.contains(live[id])) delete live[id];
        });
    }

    // =========================================================================
    // BULK REFRESH BUTTON
    // =========================================================================
    function addRefreshAllButton() {
        if (document.getElementById('ops-refresh-all')) return;
        var b = document.createElement('button');
        b.id = 'ops-refresh-all'; b.textContent = '\u21BB OPS';
        b.title = 'Refresh all OPS statuses on this page (ignores cache)';
        b.addEventListener('click', function () {
            Object.keys(live).forEach(function (id) {
                if (live[id]) forceRefresh(id, live[id]);
            });
        });
        document.body.appendChild(b);
    }

    // =========================================================================
    // BOOT  -- disconnect the observer around our own DOM writes to avoid loops.
    // =========================================================================
    var obs = null, pending = null;
    function safeScan() {
        if (obs) obs.disconnect();
        try { scanScope(); } finally { if (obs) obs.observe(document.body, { childList: true, subtree: true }); }
    }
    function boot() {
        cacheClearExpired();
        forceNextResolve = !!OPS.refreshOnLoad;
        scanScope();
        forceNextResolve = false;
        addRefreshAllButton();

        obs = new MutationObserver(function () {
            clearTimeout(pending);
            pending = setTimeout(safeScan, 400);
        });
        try { obs.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();