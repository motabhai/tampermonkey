// ==UserScript==
// @name                FortiCare Jira (FCLD) Ticket Status
// @description         Matches [EC####] in FortiCare ticket titles and shows the linked Jira Service Management (FCLD) request: status badge + activity-age chip colored by time since last activity. Refresh-on-load, per-badge + bulk refresh.
// @version             2.7
// @namespace          https://github.com/motabhai/tampermonkey/blob/main/forticare_ops.user.js
// @author              peisenberg@fortinet.com
// @grant               GM_xmlhttpRequest
// @grant               GM_getValue
// @grant               GM_setValue
// @grant               GM_deleteValue
// @grant               GM_listValues
// @grant               GM_addStyle
// @connect             jira.servicedesk.myfortinet.com
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
    var JSM = {
        // Title bracket, e.g. "[EC7957]" -> number 7957
        bracketPrefix: 'EC',
        idPattern: '\\[\\s*EC\\s*[-#]?\\s*(\\d+)\\s*\\]', // keep in sync with bracketPrefix

        base: 'https://jira.servicedesk.myfortinet.com',
        projectKey: 'FCLD',
        portalId: 51,
        issueKey:  function (num) { return this.projectKey + '-' + num; },         // FCLD-7957
        pageUrl:   function (num) { return this.base + '/servicedesk/customer/portal/' + this.portalId + '/' + this.issueKey(num); },
        apiUrl:    function (num) { return this.base + '/rest/api/2/issue/' + this.issueKey(num) + '?fields=status,created,updated'; },
        sdUrl:     function (key) { return this.base + '/rest/servicedeskapi/request/' + key; },
        sdComments:function (key) { return this.base + '/rest/servicedeskapi/request/' + key + '/comment?start=0&limit=100'; },

        cacheKey: 'jsm_',
        cacheVersion: 1,
        cacheMins: 60,
        refreshOnLoad: true,
        maxParallel: 4,
        reqTimeoutMs: 15000,

        // Activity-age chip: colour by hours since LAST ACTIVITY (issue 'updated').
        activityBuckets: [
            { maxH: 1,        bg: '#22c55e', fg: '#000' },
            { maxH: 8,        bg: '#84cc16', fg: '#000' },
            { maxH: 24,       bg: '#eab308', fg: '#000' },
            { maxH: 72,       bg: '#f97316', fg: '#fff' },
            { maxH: Infinity, bg: '#ef4444', fg: '#fff' }
        ]
    };

    // Status colouring. Jira statusCategory key is the reliable signal; status
    // name is the fallback. The badge always shows the REAL status text.
    function statusStyle(detail) {
        if (detail.status && detail.status[0] === '_') {
            return detail.status === '_error'
                ? { bg: '#a855f7', fg: '#fff' } : { bg: '#9ca3af', fg: '#000' };
        }
        var cat = (detail.catKey || '').toLowerCase();
        if (cat === 'new')           return { bg: '#3b82f6', fg: '#fff' }; // To Do
        if (cat === 'indeterminate') return { bg: '#f59e0b', fg: '#000' }; // In Progress
        if (cat === 'done')          return { bg: '#16a34a', fg: '#fff' }; // Done
        var n = (detail.status || '').toLowerCase();
        if (/(in progress|in review|escalat|working|investigat)/.test(n)) return { bg: '#f59e0b', fg: '#000' };
        if (/(resolved|done|closed|complete|cancel|declin|withdraw)/.test(n)) return { bg: '#16a34a', fg: '#fff' };
        if (/(waiting for customer|pending|with reporter|need.* info)/.test(n)) return { bg: '#3b82f6', fg: '#fff' };
        if (/(open|to do|new|reopen|waiting for support|triage|backlog)/.test(n)) return { bg: '#ef4444', fg: '#fff' };
        return { bg: '#9ca3af', fg: '#000' };
    }
    function statusLabel(detail) {
        if (detail.status === '_error') return 'ERR';
        if (detail.status === '_unknown' || !detail.status) return '?';
        var s = detail.status.toUpperCase();
        return s.length > 18 ? s.slice(0, 17) + '\u2026' : s;
    }

    // =========================================================================
    // STYLES
    // =========================================================================
    var css =
        '.jsm-badge{display:inline-flex;align-items:center;margin-left:6px;border-radius:4px;' +
        'overflow:hidden;vertical-align:middle;white-space:nowrap;background:#e5e7eb;' +
        'font:700 11px/1.5 Segoe UI,Arial,sans-serif;}' +
        '.jsm-badge .jsm-refresh{padding:1px 5px;cursor:pointer;color:#374151;opacity:.8;user-select:none;}' +
        '.jsm-badge .jsm-refresh:hover{opacity:1;}' +
        '.jsm-badge.spin .jsm-refresh{animation:jsmspin .8s linear infinite;}' +
        '@keyframes jsmspin{to{transform:rotate(360deg);}}' +
        '.jsm-badge .jsm-link{padding:1px 6px;color:#374151;text-decoration:none;}' +
        '.jsm-badge .jsm-age{padding:1px 6px;border-left:1px solid rgba(0,0,0,.18);}' +
        '#jsm-refresh-all{position:fixed;top:38px;right:10px;z-index:99999;cursor:pointer;' +
        'background:#1e3a8a;color:#fff;border:none;border-radius:5px;padding:5px 10px;' +
        'font:700 12px Segoe UI,Arial,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3);}' +
        '#jsm-refresh-all:hover{background:#1d4ed8;}';
    if (typeof GM_addStyle === 'function') { GM_addStyle(css); }
    else {
        var s = document.createElement('style'); s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }

    // =========================================================================
    // CACHE  (stores {status, catKey, created, updated})
    // =========================================================================
    function cacheRead(id) {
        try {
            var raw = GM_getValue(JSM.cacheKey + id, '');
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (o.v !== JSM.cacheVersion) return null;
            if (Date.now() - o.t > JSM.cacheMins * 60000) return null;
            return o;
        } catch (e) { return null; }
    }
    function cacheWrite(id, d) {
        try {
            GM_setValue(JSM.cacheKey + id, JSON.stringify({
                v: JSM.cacheVersion, t: Date.now(),
                status: d.status, catKey: d.catKey || null,
                created: d.created || null, updated: d.updated || null
            }));
        } catch (e) {}
    }
    function cacheDelete(id) { try { GM_deleteValue(JSM.cacheKey + id); } catch (e) {} }
    function cacheClearExpired() {
        try {
            var keys = (typeof GM_listValues === 'function') ? GM_listValues() : [];
            keys.forEach(function (k) {
                if (k.indexOf(JSM.cacheKey) !== 0) return;
                try {
                    var o = JSON.parse(GM_getValue(k, ''));
                    if (!o || o.v !== JSM.cacheVersion ||
                        Date.now() - o.t > JSM.cacheMins * 60000) { GM_deleteValue(k); }
                } catch (e) { GM_deleteValue(k); }
            });
        } catch (e) {}
    }

    // =========================================================================
    // FETCH
    // =========================================================================
    function toEpoch(v) {
        if (v == null) return null;
        if (typeof v === 'number') return v;
        var t = Date.parse(v); return isNaN(t) ? null : t;
    }

    function fetchDetail(num, cb) {
        var key = JSM.issueKey(num);
        // 1) Jira platform API (agents): status + statusCategory + updated(=last activity)
        GM_xmlhttpRequest({
            method: 'GET', url: JSM.apiUrl(num), timeout: JSM.reqTimeoutMs,
            headers: { 'Accept': 'application/json' },
            onload: function (r) {
                var d = parsePlatform(r);
                if (d) { cb(d); } else { fetchViaServiceDesk(num, key, cb); }
            },
            onerror: function () { fetchViaServiceDesk(num, key, cb); },
            ontimeout: function () { fetchViaServiceDesk(num, key, cb); }
        });
    }
    function parsePlatform(r) {
        if (!r || r.status !== 200) return null;
        try {
            var f = (JSON.parse(r.responseText) || {}).fields;
            if (!f || !f.status) return null;
            return {
                status:  f.status.name,
                catKey:  f.status.statusCategory && f.status.statusCategory.key,
                created: toEpoch(f.created),
                updated: toEpoch(f.updated)   // <-- true "last activity"
            };
        } catch (e) { return null; }
    }

    // 2) Service Desk API fallback: request (status/created) + comments (last activity)
    function fetchViaServiceDesk(num, key, cb) {
        GM_xmlhttpRequest({
            method: 'GET', url: JSM.sdUrl(key), timeout: JSM.reqTimeoutMs,
            headers: { 'Accept': 'application/json' },
            onload: function (r) {
                var d = parseSD(r);
                if (!d) { cb({ status: '_error' }); return; }
                fetchComments(key, function (lastComment) {
                    var times = [d.created, d.statusDate, lastComment].filter(function (x) { return x; });
                    d.updated = times.length ? Math.max.apply(null, times) : d.created;
                    delete d.statusDate;
                    cb(d);
                });
            },
            onerror: function () { cb({ status: '_error' }); },
            ontimeout: function () { cb({ status: '_error' }); }
        });
    }
    function parseSD(r) {
        if (!r || r.status !== 200) return null;
        try {
            var j = JSON.parse(r.responseText);
            if (!j.currentStatus || !j.currentStatus.status) return null;
            return {
                status: j.currentStatus.status,
                catKey: null,
                created: (j.createdDate && j.createdDate.epochMillis) || null,
                statusDate: (j.currentStatus.statusDate && j.currentStatus.statusDate.epochMillis) || null
            };
        } catch (e) { return null; }
    }
    function fetchComments(key, cb) {
        var latest = 0, pages = 0;
        function go(url) {
            GM_xmlhttpRequest({
                method: 'GET', url: url, timeout: JSM.reqTimeoutMs,
                headers: { 'Accept': 'application/json' },
                onload: function (r) {
                    try {
                        var j = JSON.parse(r.responseText);
                        (j.values || []).forEach(function (c) {
                            var e = c.created && c.created.epochMillis;
                            if (e && e > latest) latest = e;
                        });
                        pages++;
                        if (!j.isLastPage && j._links && j._links.next && pages < 5) { go(j._links.next); }
                        else cb(latest || null);
                    } catch (e) { cb(latest || null); }
                },
                onerror: function () { cb(latest || null); },
                ontimeout: function () { cb(latest || null); }
            });
        }
        go(JSM.sdComments(key));
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
        for (var i = 0; i < JSM.activityBuckets.length; i++) {
            if (h <= JSM.activityBuckets[i].maxH) return JSM.activityBuckets[i];
        }
        return JSM.activityBuckets[JSM.activityBuckets.length - 1];
    }

    // =========================================================================
    // RENDER
    // =========================================================================
    function badgeEl(num) {
        var span = document.createElement('span');
        span.className = 'jsm-badge loading jsm-badge-' + num;
        span.setAttribute('data-jsm-num', num);
        span.innerHTML =
            '<span class="jsm-refresh" title="Refresh this Jira status">\u21BB</span>' +
            '<a class="jsm-link" href="' + JSM.pageUrl(num) +
            '" target="_blank" rel="noopener">' + JSM.bracketPrefix + num + '\u2026</a>' +
            '<span class="jsm-age" style="display:none"></span>';
        span.querySelector('.jsm-refresh').addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation(); forceRefresh(num, span);
        });
        return span;
    }

    function paint(span, d, fetchedTs) {
        var num = span.getAttribute('data-jsm-num');
        var st = statusStyle(d);
        span.classList.remove('loading', 'spin');

        var link = span.querySelector('.jsm-link');
        link.style.background = st.bg; link.style.color = st.fg;
        link.textContent = JSM.bracketPrefix + num + ' \u00B7 ' + statusLabel(d);

        var tip = [JSM.issueKey(num) + ' \u2014 ' +
            (d.status && d.status[0] === '_' ? 'status unavailable' : (d.status || '?'))];

        var ageEl = span.querySelector('.jsm-age');
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
        var link = span.querySelector('.jsm-link');
        if (link) { link.style.background = ''; link.style.color = ''; link.textContent = JSM.bracketPrefix + span.getAttribute('data-jsm-num') + '\u2026'; }
        var ageEl = span.querySelector('.jsm-age'); if (ageEl) ageEl.style.display = 'none';
    }

    var forceNextResolve = false;
    function resolve(num, span) {
        if (!forceNextResolve) {
            var cached = cacheRead(num);
            if (cached) { paint(span, cached, cached.t); return; }
        }
        queue.push({ num: num, span: span }); pump();
    }
    function forceRefresh(num, span) {
        cacheDelete(num); setLoading(span);
        queue.push({ num: num, span: span }); pump();
    }

    var queue = [], active = 0;
    function pump() {
        while (active < JSM.maxParallel && queue.length) {
            var job = queue.shift(); active++;
            (function (job) {
                fetchDetail(job.num, function (d) {
                    var ts = Date.now();
                    if (d.status && d.status[0] !== '_') cacheWrite(job.num, d);
                    paint(job.span, d, ts);
                    active--; pump();
                });
            })(job);
        }
    }

    // =========================================================================
    // SCAN + RECONCILE  -- exactly one live badge per Jira id, in a visible
    // title cell. Works standalone (no dependency on the main FortiCare script)
    // and survives the SLA-Monitor row cloning.
    // =========================================================================
    var live = {}; // num -> live badge span we created

    function extractIds(text) {
        var re = new RegExp(JSM.idPattern, 'gi'); var ids = {}, m;
        while ((m = re.exec(text)) !== null) { ids[m[1]] = true; }
        return Object.keys(ids);
    }
    function isVisible(el) { return !!(el && el.offsetParent !== null); }

    // Real ticket rows carry a ...?TID=... link, but that link is added by the
    // main FortiCare script. So this is only a PREFERENCE: when present we anchor
    // to that row; when absent (main script disabled) we fall back to the first
    // visible leaf title cell.
    function rowHasTicketLink(cell) {
        var tr = cell.closest && cell.closest('tr');
        return !!(tr && tr.querySelector('a[href*="TID="]'));
    }
    // Leaf cell holds the title text directly; wrapper cells that contain the
    // whole results table are rejected so the badge lands in the title cell.
    function isLeafCell(cell) { return !cell.querySelector('td, table'); }

    function reconcileId(num, hostCell) {
        var cur = live[num];
        document.querySelectorAll('.jsm-badge-' + num).forEach(function (b) {
            if (b !== cur) b.remove(); // strip clones
        });
        if (cur && document.contains(cur) && isVisible(cur)) return;
        if (cur) { cur.remove(); delete live[num]; }
        if (!hostCell || !isVisible(hostCell)) return;
        var span = badgeEl(num);
        hostCell.appendChild(span);
        live[num] = span;
        resolve(num, span);
    }

    function scanScope() {
        var firstCell = {}; // num -> { cell, inRow }

        document.querySelectorAll('td').forEach(function (cell) {
            if (!isVisible(cell) || !isLeafCell(cell)) return;
            var ids = extractIds(cell.textContent || '');
            if (!ids.length) return;
            var inRow = rowHasTicketLink(cell);
            ids.forEach(function (num) {
                var c = firstCell[num];
                if (!c) firstCell[num] = { cell: cell, inRow: inRow };
                else if (!c.inRow && inRow) firstCell[num] = { cell: cell, inRow: inRow };
            });
        });

        // Fallback for the single-ticket detail page (title in a header element).
        ['ctl00_MainContent_L_Title', 'ctl00_MainContent_L_Info'].forEach(function (eid) {
            var el = document.getElementById(eid);
            if (!el || !isVisible(el)) return;
            extractIds(el.textContent || '').forEach(function (num) {
                if (!firstCell[num]) firstCell[num] = { cell: el, inRow: false };
            });
        });

        Object.keys(firstCell).forEach(function (num) { reconcileId(num, firstCell[num].cell); });
        Object.keys(live).forEach(function (num) {
            if (!live[num] || !document.contains(live[num])) delete live[num];
        });
    }

    // =========================================================================
    // BULK REFRESH BUTTON
    // =========================================================================
    function addRefreshAllButton() {
        if (document.getElementById('jsm-refresh-all')) return;
        var b = document.createElement('button');
        b.id = 'jsm-refresh-all'; b.textContent = '\u21BB JIRA';
        b.title = 'Refresh all Jira (FCLD) statuses on this page (ignores cache)';
        b.addEventListener('click', function () {
            Object.keys(live).forEach(function (num) {
                if (live[num]) forceRefresh(num, live[num]);
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
        forceNextResolve = !!JSM.refreshOnLoad;
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