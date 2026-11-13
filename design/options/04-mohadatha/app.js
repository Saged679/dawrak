(function () {
  var thread = document.getElementById('thread');
  var typing = document.getElementById('typing');
  var newEv = document.getElementById('newEv');
  var live = document.getElementById('live');
  var replay = document.getElementById('replay');
  var pick = thread.querySelector('[data-pick]');
  var steps = Array.prototype.slice.call(thread.querySelectorAll('[data-step]'));
  var voice = thread.querySelector('.voice');
  var bars = Array.prototype.slice.call(voice.querySelectorAll('.wave i'));
  var play = voice.querySelector('.play');
  var timers = [];
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function clear() { timers.forEach(clearTimeout); timers = []; }
  function down() { thread.scrollTop = thread.scrollHeight; }

  function fillWave(ms, done) {
    var per = ms / bars.length, i = 0;
    play.setAttribute('aria-pressed', 'true');
    bars.forEach(function (b) { b.classList.remove('on'); });
    (function tick() {
      if (i < bars.length) { bars[i++].classList.add('on'); later(tick, per); }
      else { play.setAttribute('aria-pressed', 'false'); if (done) done(); }
    })();
  }

  function show(n) {
    var el = steps[n - 1];
    el.classList.remove('pending');
    el.classList.add('enter');
    down();
  }
  function typeThen(n, ms) {
    thread.appendChild(typing);
    typing.hidden = false;
    down();
    later(function () { typing.hidden = true; show(n); }, ms);
  }

  function finalState() {
    clear();
    steps.forEach(function (s) { s.classList.remove('pending', 'enter'); });
    pick.classList.add('chosen');
    newEv.classList.remove('pending');
    live.classList.add('show');
    typing.hidden = true;
    bars.forEach(function (b) { b.classList.add('on'); });
    down();
  }

  function run() {
    clear();
    steps.forEach(function (s) { s.classList.add('pending'); s.classList.remove('enter'); });
    pick.classList.remove('chosen');
    newEv.classList.add('pending');
    live.classList.remove('show');
    bars.forEach(function (b) { b.classList.remove('on'); });
    replay.hidden = true;
    thread.scrollTop = 0;

    later(function () { show(1); fillWave(2200); }, 700);
    later(function () { typeThen(2, 1500); }, 3300);
    later(function () { show(3); }, 6600);
    later(function () { typeThen(4, 1400); }, 7600);
    later(function () { pick.classList.add('chosen'); }, 10200);
    later(function () { show(5); }, 10700);
    later(function () { typeThen(6, 1800); }, 11500);
    later(function () {
      newEv.classList.remove('pending');
      live.classList.add('show');
      replay.hidden = false;
    }, 13500);
  }

  play.addEventListener('click', function () {
    if (play.getAttribute('aria-pressed') === 'true') return;
    fillWave(2200);
  });
  replay.addEventListener('click', function () {
    document.documentElement.classList.add('js');
    run();
  });

  if (reduced) { finalState(); return; }
  document.documentElement.classList.add('js');
  run();
})();
