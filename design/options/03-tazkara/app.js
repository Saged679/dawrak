(function () {
  var ticket = document.getElementById('ticket');
  var num = document.getElementById('tNum');
  var svc = document.getElementById('tSvc');
  var doc = document.getElementById('tDoc');
  var time = document.getElementById('tTime');
  var greg = document.getElementById('tGreg');
  var hijri = document.getElementById('tHijri');
  var stamp = document.getElementById('confirm');

  // Real Gregorian + Hijri date for the chosen day (today). Falls back to the static text.
  try {
    var d = new Date();
    greg.textContent = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
    hijri.textContent = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }).format(d).replace(/ هـ?$/, '') + ' هـ';
  } catch (e) {}

  function update(bump) {
    var s = document.querySelector('input[name="svc"]:checked');
    var t = document.querySelector('input[name="slot"]:checked');
    svc.textContent = s.value;
    doc.textContent = s.dataset.doc;
    time.textContent = t.value + ' PM';
    // The queue number depends on the slot: later slot, higher number.
    var next = t.dataset.n.padStart(2, '0');
    if (num.textContent !== next) {
      num.textContent = next;
      if (bump) { num.classList.remove('bump'); void num.offsetWidth; num.classList.add('bump'); }
    }
    ticket.classList.remove('stamped');
  }

  document.querySelectorAll('.pick input').forEach(function (i) {
    i.addEventListener('change', function () { update(true); });
  });
  stamp.addEventListener('click', function () { ticket.classList.add('stamped'); });
  update(false);
})();
