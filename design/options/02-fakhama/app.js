// Slot selection in the hero booking mock.
document.querySelectorAll('.slot:not([disabled])').forEach(function (btn, _, all) {
  btn.addEventListener('click', function () {
    all.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
  });
});
