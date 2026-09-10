/* Retired: this block used native Shopify carts without a backend HOLD.
   Fail closed even if an old template enables it again. No demo dates,
   local rental rules, cart mutations or checkout redirects are allowed. */
(function () {
  'use strict';

  function boot(scope) {
    (scope || document).querySelectorAll('[data-vsc-rental]').forEach(function (root) {
      root.querySelectorAll('button').forEach(function (button) { button.disabled = true; });
      root.querySelectorAll('[data-vsc-cal], [data-vsc-summary], [data-vsc-note]').forEach(function (el) { el.hidden = true; });
      var status = root.querySelector('[data-vsc-status]');
      if (status) {
        status.textContent = root.dataset.retiredMessage || 'Online reservation unavailable.';
        status.className = 'vsc-status vsc-status--error';
        status.hidden = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  } else {
    boot();
  }
  document.addEventListener('shopify:section:load', function (event) { boot(event.target); });
})();
