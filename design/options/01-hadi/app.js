// Appointment-slip demo: picking a time updates the slip and its queue number.
(function () {
  var time = document.getElementById('slipTime');
  var num = document.getElementById('slipNum');
  var slots = document.querySelectorAll('.slot:not(.is-off)');
  slots.forEach(function (btn) {
    btn.addEventListener('click', function () {
      slots.forEach(function (b) {
        b.classList.remove('is-on');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('is-on');
      btn.setAttribute('aria-pressed', 'true');
      time.textContent = btn.dataset.time;
      num.textContent = btn.dataset.num;
      var slip = document.querySelector('.slip');
      slip.classList.remove('is-stamp');
      void slip.offsetWidth;
      slip.classList.add('is-stamp');
    });
  });
})();
