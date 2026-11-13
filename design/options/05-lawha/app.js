(function () {
  'use strict';
  var START = 9, END = 19, HH = 64, NOW = 12 * 60 + 20; // demo clock 12:20
  var root = document.documentElement;

  /* ---------- theme ---------- */
  var themeBtn = document.getElementById('theme'), themeTxt = document.getElementById('themeTxt');
  function paintTheme() {
    var dark = root.dataset.theme === 'dark';
    themeBtn.setAttribute('aria-pressed', dark);
    themeTxt.textContent = dark ? 'نهاري' : 'ليلي';
  }
  themeBtn.addEventListener('click', function () {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('dawrak-theme', root.dataset.theme); } catch (e) {}
    paintTheme();
  });
  paintTheme();

  /* ---------- data ---------- */
  var STATUS = {
    confirmed: { label: 'مؤكد', mark: 'confirmed' },
    waiting:   { label: 'بانتظار التأكيد', mark: 'waiting' },
    live:      { label: 'في الجلسة', mark: 'live' },
    done:      { label: 'تمّ', mark: 'done' },
    noshow:    { label: 'لم يحضر', mark: 'noshow' }
  };
  var ORDER = ['confirmed', 'waiting', 'live', 'done', 'noshow'];
  var DOCS = [
    { id: 0, name: 'د. هند القحطاني', role: 'جلدية وتجميل' },
    { id: 1, name: 'د. ماجد الشهري', role: 'أسنان' },
    { id: 2, name: 'د. سارة العمري', role: 'أسنان أطفال' },
    { id: 3, name: 'د. أحمد فؤاد', role: 'باطنة' }
  ];
  var SVC = {
    kj: ['كشف جلدية', 150], lz: ['ليزر، جلسة', 600], tn: ['تنظيف وتلميع', 150], tq: ['تقويم، متابعة', 300],
    as: ['علاج عصب', 450], hs: ['حشو', 200], ka: ['كشف أطفال', 100], kb: ['كشف باطنة', 120], tb: ['تحليل ومتابعة', 180]
  };
  var DAYS = [
    { n: 'الأحد', d: 8 }, { n: 'الإثنين', d: 9 }, { n: 'الثلاثاء', d: 10 }, { n: 'الأربعاء', d: 11 }, { n: 'الخميس', d: 12 },
    { n: 'الأحد', d: 15 }, { n: 'الإثنين', d: 16 }, { n: 'الثلاثاء', d: 17 }
  ];
  var TODAY = 4;
  var HIJRI = ['27 جمادى الأولى', '28 جمادى الأولى', '29 جمادى الأولى', '1 جمادى الآخرة', '2 جمادى الآخرة', '5 جمادى الآخرة', '6 جمادى الآخرة', '7 جمادى الآخرة'];

  // [doctor, start, duration, patient, service, status, source]
  var RAW = [
    [0,'09:00',30,'ريم السبيعي','kj','done','هاتف'], [0,'09:30',45,'نوف الدوسري','lz','done','الموقع'],
    [0,'10:30',30,'دانة الحربي','kj','noshow','واتساب'], [0,'11:00',30,'إيمان سعيد','kj','done','واتساب'],
    [0,'11:45',60,'لمى الغامدي','lz','live','الموقع'], [0,'13:15',30,'فاطمة الزهراني','kj','confirmed','واتساب'],
    [0,'14:00',45,'شهد المطيري','lz','waiting','الموقع'], [0,'15:30',30,'منى العجمي','kj','confirmed','هاتف'],
    [0,'16:30',45,'نورة البقمي','lz','waiting','واتساب'],

    [1,'09:00',45,'خالد العنزي','tn','done','هاتف'], [1,'10:00',30,'فيصل الجهني','tn','noshow','الموقع'],
    [1,'10:30',30,'تركي الشمري','tq','done','واتساب'], [1,'11:00',45,'سلطان القرني','hs','done','الموقع'],
    [1,'12:00',30,'عبدالله الحازمي','tn','live','هاتف'], [1,'12:30',30,'بدر المالكي','tn','confirmed','واتساب'],
    [1,'13:30',60,'ياسر العسيري','as','waiting','الموقع'], [1,'15:00',30,'ماجد البلوي','tq','confirmed','هاتف'],
    [1,'16:00',45,'هشام الرشيدي','hs','confirmed','واتساب'], [1,'18:00',30,'مها العتيبي','tn','confirmed','واتساب'],

    [2,'09:00',30,'يوسف الشريف','ka','done','الموقع'], [2,'09:45',30,'لين الحمدان','ka','done','واتساب'],
    [2,'10:30',30,'عمر الخالدي','ka','noshow','هاتف'], [2,'11:15',45,'جود الصاعدي','hs','done','الموقع'],
    [2,'12:00',30,'ريان الفيفي','ka','live','واتساب'], [2,'12:45',30,'سيلين منصور','ka','confirmed','الموقع'],
    [2,'14:00',45,'آدم الغنام','hs','waiting','واتساب'], [2,'15:00',30,'تالا المطيري','ka','confirmed','هاتف'],
    [2,'16:30',30,'رزان الأحمدي','ka','confirmed','الموقع'],

    [3,'09:00',30,'محمود عبدالفتاح','kb','done','هاتف'], [3,'09:30',30,'هبة السيد','kb','done','الموقع'],
    [3,'10:15',30,'مصطفى كمال','tb','done','واتساب'], [3,'11:00',30,'إسراء حسن','kb','noshow','واتساب'],
    [3,'11:30',30,'سعد الدوسري','kb','done','هاتف'], [3,'12:15',30,'عادل الزهراني','tb','live','الموقع'],
    [3,'13:00',30,'نادية البدر','kb','confirmed','واتساب'], [3,'13:45',30,'طارق الفرج','kb','confirmed','الموقع'],
    [3,'14:30',30,'وفاء شريف','tb','waiting','واتساب'], [3,'16:00',30,'حسام الدين','kb','confirmed','هاتف'],
    [3,'17:00',30,'أمل القحطاني','kb','waiting','الموقع']
  ];
  function mins(t) { var p = t.split(':'); return +p[0] * 60 + +p[1]; }
  function hm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  var uid = 0;
  function mk(r) { var s = SVC[r[4]]; return { id: ++uid, doc: r[0], s: mins(r[1]), dur: r[2], patient: r[3], svc: s[0], price: s[1], status: r[5], src: r[6] }; }

  var store = {};
  store[TODAY] = RAW.map(mk);

  // deterministic filler for the other days
  var NAMES = ['سامي الحربي','رغد القرشي','بسمة نور','وليد الشمراني','ليلى فتحي','نايف السهلي','أروى باشا','كريم عادل','شيماء رمضان','رائد الجابري','جمانة آل سعود','ثامر العوفي','غادة الراجحي','زياد مصطفى'];
  var SVCK = ['kj','lz','tn','tq','hs','ka','kb','tb'];
  function seeded(seed) { var x = seed; return function () { x = (x * 9301 + 49297) % 233280; return x / 233280; }; }
  function gen(day) {
    var rnd = seeded(day * 97 + 13), out = [], past = day < TODAY;
    DOCS.forEach(function (d) {
      var t = 9 * 60 + Math.floor(rnd() * 3) * 15;
      while (t < 17.5 * 60) {
        var dur = [30, 30, 45, 60][Math.floor(rnd() * 4)];
        if (rnd() > 0.2) {
          var k = SVCK[Math.floor(rnd() * SVCK.length)], st;
          if (past) st = rnd() < 0.08 ? 'noshow' : 'done';
          else st = rnd() < 0.3 ? 'waiting' : 'confirmed';
          out.push(mk([d.id, hm(t), dur, NAMES[Math.floor(rnd() * NAMES.length)], k, st, ['واتساب', 'الموقع', 'هاتف'][Math.floor(rnd() * 3)]]));
        }
        t += dur + (rnd() < 0.5 ? 0 : 15);
      }
    });
    return out;
  }
  function day(i) { return store[i] || (store[i] = gen(i)); }

  /* ---------- state ---------- */
  var st = { view: 'day', day: TODAY, sel: null, hidden: {} };
  var first = store[TODAY].filter(function (a) { return a.status === 'live' && a.doc === 0; })[0];
  st.sel = first.id;

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return n.toLocaleString('en-US'); };
  var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
  function dayTitle(i) { var d = DAYS[i]; return d.n + ' ' + d.d + ' نوفمبر'; }

  /* ---------- KPIs ---------- */
  function kpis() {
    var a = day(TODAY), c = {}, rev = 0, exp = 0;
    ORDER.forEach(function (k) { c[k] = 0; });
    a.forEach(function (x) { c[x.status]++; if (x.status === 'done' || x.status === 'live') rev += x.price; if (x.status !== 'noshow') exp += x.price; });
    var seen = c.done + c.noshow + c.live;
    $('kTotal').textContent = a.length;
    $('kTotalSub').textContent = c.done + ' تمّت · ' + c.live + ' جارية · ' + (c.confirmed + c.waiting) + ' قادمة';
    $('kRev').textContent = fmt(rev);
    $('kRevSub').textContent = 'المتوقع حتى المساء ' + fmt(exp) + ' ر.س';
    $('kNo').textContent = seen ? (c.noshow / seen * 100).toFixed(1) : '0';
    $('kNoSub').textContent = c.noshow + ' من ' + seen + ' موعداً حتى الآن';
    $('kWait').textContent = c.waiting;
    $('kWaitSub').textContent = 'ينتظر العربون أو الرد';
    // doctor table
    $('docRows').innerHTML = DOCS.map(function (d) {
      var mine = a.filter(function (x) { return x.doc === d.id; }), m = 0, r = 0;
      mine.forEach(function (x) { if (x.status !== 'noshow') m += x.dur; if (x.status === 'done' || x.status === 'live') r += x.price; });
      var u = Math.round(m / ((END - START) * 60) * 100);
      return '<tr><th scope="row">' + d.name + '<br><small style="font-weight:400;color:var(--ink3)">' + d.role + '</small></th><td class="num">' + mine.length +
        '</td><td><span class="util"><i><b style="width:' + u + '%"></b></i><span class="num">' + u + '%</span></span></td><td class="num">' + fmt(r) + '</td></tr>';
    }).join('');
  }

  /* ---------- legend ---------- */
  function legend() {
    $('legend').innerHTML = ORDER.map(function (k) {
      return '<li><button type="button" data-k="' + k + '" aria-pressed="' + !st.hidden[k] + '"><span class="mark mark--' + STATUS[k].mark + '"></span>' + STATUS[k].label + '</button></li>';
    }).join('');
  }

  /* ---------- day view ---------- */
  function dayView() {
    var a = day(st.day), isToday = st.day === TODAY, body = (END - START) * HH, h = '';
    h += '<div class="cal" style="--hh:' + HH + 'px;grid-template-columns:52px repeat(4,minmax(150px,1fr))">';
    h += '<div class="cal__corner"></div>';
    DOCS.forEach(function (d) {
      var m = 0; a.forEach(function (x) { if (x.doc === d.id && x.status !== 'noshow') m += x.dur; });
      h += '<div class="cal__head">' + d.name + '<small>' + d.role + '</small><span class="load" aria-hidden="true"><i style="width:' + Math.min(100, Math.round(m / 6)) + '%"></i></span></div>';
    });
    h += '<div class="hours" style="height:' + body + 'px">';
    for (var i = 0; i < END - START; i++) h += '<span style="top:' + (i * HH) + 'px">' + hm((START + i) * 60) + '</span>';
    if (isToday) h += '<span class="nowtag" style="top:' + ((NOW - START * 60) / 60 * HH) + 'px">12:20</span>';
    h += '</div>';
    DOCS.forEach(function (d) {
      h += '<div class="col" style="height:' + body + 'px">';
      if (isToday) h += '<div class="nowline" style="top:' + ((NOW - START * 60) / 60 * HH) + 'px"></div>';
      a.filter(function (x) { return x.doc === d.id; }).forEach(function (x) {
        var top = (x.s - START * 60) / 60 * HH + 1, ht = x.dur / 60 * HH - 2, s = STATUS[x.status];
        h += '<button type="button" class="appt appt--' + x.status + (x.dur <= 30 ? ' appt--short' : '') + (st.hidden[x.status] ? ' is-dim' : '') +
          '" data-id="' + x.id + '" aria-pressed="' + (st.sel === x.id) + '" style="top:' + top + 'px;height:' + ht + 'px">' +
          '<b><span class="mark mark--' + s.mark + '" style="margin-inline-end:6px"></span>' + esc(x.patient) + '</b>' +
          '<span>' + esc(x.svc) + '</span><time>' + hm(x.s) + '–' + hm(x.s + x.dur) + '</time><i>' + s.label + '</i></button>';
      });
      h += '</div>';
    });
    h += '</div>';
    return h;
  }

  /* ---------- week view ---------- */
  function weekView() {
    var h = '<div class="wk"><div class="wk__h">الطبيب</div>';
    for (var i = 0; i < 5; i++) h += '<div class="wk__h ' + (i === TODAY ? 'wk--today' : '') + '"><button type="button" data-day="' + i + '">' + DAYS[i].n + '<small>' + DAYS[i].d + ' نوفمبر' + (i === TODAY ? ' · اليوم' : '') + '</small></button></div>';
    DOCS.forEach(function (d) {
      h += '<div class="wk__doc">' + d.name + '<small>' + d.role + '</small></div>';
      for (var i = 0; i < 5; i++) {
        var a = day(i).filter(function (x) { return x.doc === d.id; }), tot = a.length, c = {}, rev = 0;
        ORDER.forEach(function (k) { c[k] = 0; });
        a.forEach(function (x) { c[x.status]++; if (x.status === 'done' || x.status === 'live') rev += x.price; });
        h += '<button type="button" class="wk__cell ' + (i === TODAY ? 'wk--today' : '') + '" data-day="' + i + '" aria-label="' + d.name + '، ' + dayTitle(i) + '، ' + tot + ' موعداً">' +
          '<span class="wk__n">' + tot + ' · ' + fmt(rev) + '</span><span class="stack" aria-hidden="true">' +
          ORDER.map(function (k) { return c[k] ? '<i style="flex:' + c[k] + ';background:var(--s-' + ({ confirmed: 'conf', waiting: 'wait', live: 'live', done: 'done', noshow: 'no' })[k] + ')"></i>' : ''; }).join('') + '</span></button>';
      }
    });
    return h + '</div>';
  }

  /* ---------- detail ---------- */
  var NEXT = {
    waiting:   [['confirmed', 'تأكيد الموعد', 'pri'], ['noshow', 'لم يحضر', 'bad']],
    confirmed: [['live', 'بدأت الجلسة', 'pri'], ['noshow', 'لم يحضر', 'bad']],
    live:      [['done', 'إنهاء الجلسة', 'pri'], ['confirmed', 'إرجاع', '']],
    done:      [['live', 'تراجع', '']],
    noshow:    [['confirmed', 'إعادة فتح الموعد', 'pri']]
  };
  function find(id) { var r = null; Object.keys(store).forEach(function (k) { store[k].forEach(function (x) { if (x.id === id) r = x; }); }); return r; }
  function detail() {
    var x = find(st.sel), el = $('detail');
    if (!x) { el.innerHTML = '<h3>تفاصيل الموعد</h3><p class="detail__empty">اضغط أي موعد في الجدول لتراه هنا.</p>'; return; }
    var s = STATUS[x.status], d = DOCS[x.doc];
    el.innerHTML = '<span class="pill appt--' + x.status + '"><span class="mark mark--' + s.mark + '"></span>' + s.label + '</span>' +
      '<h3>' + esc(x.patient) + '</h3>' +
      '<dl class="dl"><dt>الخدمة</dt><dd>' + esc(x.svc) + '</dd><dt>الطبيب</dt><dd>' + d.name + '</dd><dt>الوقت</dt><dd><span class="num">' + hm(x.s) + '–' + hm(x.s + x.dur) + '</span></dd>' +
      '<dt>اليوم</dt><dd>' + dayTitle(st.day) + '<br><small style="color:var(--ink3)">' + HIJRI[st.day] + ' 1448 هـ</small></dd>' +
      '<dt>جاء من</dt><dd>' + x.src + '</dd><dt>السعر</dt><dd><span class="num">' + fmt(x.price) + '</span> ر.س</dd></dl>' +
      '<div class="acts">' + NEXT[x.status].map(function (n) { return '<button type="button" class="' + n[2] + '" data-to="' + n[0] + '">' + n[1] + '</button>'; }).join('') + '</div>';
  }

  /* ---------- render ---------- */
  function render(focusId) {
    var week = st.view === 'week';
    $('grid').innerHTML = week ? weekView() : dayView();
    $('dayLabel').textContent = week ? 'الأسبوع 8 – 12 نوفمبر' : dayTitle(st.day) + ' · ' + HIJRI[st.day];
    $('prev').hidden = $('next').hidden = week;
    $('prev').disabled = st.day === 0; $('next').disabled = st.day === DAYS.length - 1;
    $('legend').hidden = week;
    $('tabDay').setAttribute('aria-selected', !week); $('tabWeek').setAttribute('aria-selected', week);
    detail(); kpis();
    if (week) $('detail').innerHTML = '<h3>نظرة على الأسبوع</h3><p class="detail__empty">كل خانة تعرض عدد المواعيد والإيراد، والشريط يوزعها حسب الحالة. اضغط أي يوم لتفتحه.</p>';
    if (focusId) { var b = document.querySelector('.appt[data-id="' + focusId + '"]'); if (b) b.focus({ preventScroll: true }); }
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.dataset.view) { st.view = t.dataset.view; render(); }
    else if (t.dataset.day !== undefined) { st.day = +t.dataset.day; st.view = 'day'; st.sel = null; render(); }
    else if (t.classList.contains('appt')) { st.sel = +t.dataset.id; render(st.sel); }
    else if (t.dataset.to) { var x = find(st.sel); if (x) { x.status = t.dataset.to; render(x.id); var n = document.querySelector('#detail [data-to]'); if (n) n.focus({ preventScroll: true }); } }
    else if (t.dataset.k) { st.hidden[t.dataset.k] = !st.hidden[t.dataset.k]; legend(); render(); document.querySelector('#legend [data-k="' + t.dataset.k + '"]').focus(); }
    else if (t.id === 'prev' || t.id === 'next') { st.day += t.id === 'next' ? 1 : -1; st.sel = null; render(); }
  });

  /* ---------- bars ---------- */
  var V = [11, 12, 10, 11, 9, 11, 10, 8, 7, 6, 6, 5, 4, 4];
  $('bars').innerHTML = V.map(function (v, i) { return '<span class="' + (i > 6 ? 'after' : '') + '" style="height:' + (v * 9) + 'px"><em>' + v + '</em></span>'; }).join('');

  legend(); render();
  // scroll calendar so the "now" line is in view
  var cw = $('calwrap'); cw.scrollTop = Math.max(0, (NOW - START * 60) / 60 * HH - 160);
})();
