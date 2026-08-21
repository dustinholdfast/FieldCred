// Shared behavior for FieldCred Help Center article pages.
// The hub (index.html) has its own inline filtering script; this file only
// handles the header search box on article pages, which redirects back to
// the hub with a ?q= so search always has one real, working home.
(function () {
  function initHeaderSearch() {
    var form = document.getElementById('kb-header-search');
    if (!form) return;
    var input = form.querySelector('input');
    var target = form.getAttribute('data-index-href') || '../index.html';
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = (input.value || '').trim();
      window.location.href = q ? target + '?q=' + encodeURIComponent(q) : target;
    });
  }
  document.addEventListener('DOMContentLoaded', initHeaderSearch);
})();
