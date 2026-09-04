/* VS BY CLOSET — aluguel. Ver README.md desta pasta para as decisões.
   Enxuto de propósito: limite de 10 KB por JS de app block. */
(function () {
  'use strict';

  /* Padrões temporários — passam a vir da API quando o painel admin entrar.
     A tabela peças→dias está pendente de confirmação (ver README). */
  var D = {
    minAdvanceDays: 15,
    blackoutStart: '06-01',
    blackoutEnd: '09-30',
    maxPieces: 6,
    piecesToDays: [
      { upTo: 2, days: 2 },
      { upTo: 4, days: 3 },
      { upTo: 6, days: 4 }
    ]
  };

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function addDays(d, n) {
    var c = startOfDay(d);
    c.setDate(c.getDate() + n);
    return c;
  }
  function toISO(d) {
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }
  function fromISO(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function sameDay(a, b) {
    return toISO(a) === toISO(b);
  }

  function Cal(root) {
    var ds = root.dataset;
    this.root = root;
    this.sku = ds.sku;
    this.variantId = ds.variantId;
    this.title = ds.productTitle || '';
    this.api = (ds.availabilityUrl || '').trim();
    this.wa = (ds.whatsapp || '').replace(/\D/g, '');
    this.locale = ds.locale || 'pt-BR';

    var adv = parseInt(ds.minAdvanceDays, 10);
    this.r = {
      minAdvanceDays: isNaN(adv) ? D.minAdvanceDays : adv,
      blackoutStart: ds.blackoutStart || D.blackoutStart,
      blackoutEnd: ds.blackoutEnd || D.blackoutEnd,
      maxPieces: D.maxPieces,
      piecesToDays: D.piecesToDays
    };

    this.today = startOfDay(new Date());
    /* Primeiro dia realmente reservável: today + antecedência JÁ pulando o
       bloqueio de alta temporada. Sem pular, o calendário abriria em
       setembro (dentro do bloqueio) mostrando o mês inteiro morto, e o
       cliente teria que adivinhar que precisa navegar até outubro. */
    this.first = this.firstOpenDay(addDays(this.today, this.r.minAdvanceDays));
    this.busy = [];
    this.sel = null;
    this.pieces = 1;
    this.demo = false;
    this.failed = false;

    var q = function (s) {
      return root.querySelector(s);
    };
    this.e = {
      month: q('[data-vsc-month]'),
      weekdays: q('[data-vsc-weekdays]'),
      grid: q('[data-vsc-grid]'),
      prev: q('[data-vsc-prev]'),
      next: q('[data-vsc-next]'),
      sum: q('[data-vsc-summary]'),
      pickup: q('[data-vsc-pickup]'),
      ret: q('[data-vsc-return]'),
      period: q('[data-vsc-period]'),
      note: q('[data-vsc-note]'),
      status: q('[data-vsc-status]'),
      submit: q('[data-vsc-submit]'),
      spin: q('[data-vsc-btn-spin]'),
      contact: q('[data-vsc-contact]')
    };

    /* Abre no mês do primeiro dia reservável, não no mês atual. */
    this.view = new Date(this.first.getFullYear(), this.first.getMonth(), 1);
    this.init();
  }

  Cal.prototype.t = function (k) {
    return (window.VSC_RENTAL_I18N || {})[k] || k;
  };

  Cal.prototype.init = function () {
    if (!this.e.grid) return;
    this.weekdays();
    this.bind();
    var s = this;
    Promise.all([this.loadCart(), this.loadAvail()]).then(function () {
      s.render();
    });
  };

  Cal.prototype.bind = function () {
    var s = this;
    this.e.prev.addEventListener('click', function () {
      s.view.setMonth(s.view.getMonth() - 1);
      s.render();
    });
    this.e.next.addEventListener('click', function () {
      s.view.setMonth(s.view.getMonth() + 1);
      s.render();
    });
    this.e.grid.addEventListener('click', function (ev) {
      var b = ev.target.closest('.vsc-day');
      if (b && !b.disabled && b.dataset.date) {
        s.sel = fromISO(b.dataset.date);
        s.render();
      }
    });
    this.e.grid.addEventListener('keydown', function (ev) {
      var step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
      var b = ev.target.closest('.vsc-day');
      if (!step || !b || !b.dataset.date) return;
      ev.preventDefault();
      s.moveFocus(b.dataset.date, step);
    });
    if (this.e.submit) {
      this.e.submit.addEventListener('click', function () {
        s.submit();
      });
    }
  };

  /* Conta as peças do carrinho — é isso que define a duração.
     Pendência: acessório ainda entra na conta (ver README). */
  Cal.prototype.loadCart = function () {
    var s = this;
    return fetch('/cart.js', { headers: { Accept: 'application/json' } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (c) {
        var n = c && typeof c.item_count === 'number' ? c.item_count : 0;
        s.pieces = Math.min(n + 1, s.r.maxPieces);
      })
      .catch(function () {
        s.pieces = 1;
      });
  };

  Cal.prototype.loadAvail = function () {
    var s = this;
    if (!this.api || !this.sku) {
      this.demo = true;
      [4, 5, 6, 12, 13, 19, 20, 21].forEach(function (o) {
        s.busy.push(toISO(addDays(s.first, o)));
      });
      return Promise.resolve();
    }
    return fetch(this.api + '?sku=' + encodeURIComponent(this.sku), {
      headers: { Accept: 'application/json' }
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        s.busy = Array.isArray(d.unavailable) ? d.unavailable : [];
      })
      .catch(function () {
        /* Falha nunca vira "tudo livre". */
        s.failed = true;
      });
  };

  /* Avança até sair do bloqueio. Teto de 400 dias porque uma configuração
     errada (bloqueio de 01-01 a 12-31) travaria o navegador num laço
     infinito — melhor devolver a data original e o calendário mostrar
     tudo bloqueado do que a página congelar. */
  Cal.prototype.firstOpenDay = function (from) {
    var d = from;
    for (var i = 0; i < 400; i++) {
      if (!this.inBlackout(d)) return d;
      d = addDays(d, 1);
    }
    return from;
  };

  Cal.prototype.inBlackout = function (d) {
    var md = toISO(d).slice(5),
      a = this.r.blackoutStart,
      b = this.r.blackoutEnd;
    if (!a || !b) return false;
    return a <= b ? md >= a && md <= b : md >= a || md <= b;
  };

  Cal.prototype.days = function () {
    var t = this.r.piecesToDays;
    for (var i = 0; i < t.length; i++) if (this.pieces <= t[i].upTo) return t[i].days;
    return t[t.length - 1].days;
  };

  Cal.prototype.end = function (start) {
    return addDays(start, this.days() - 1);
  };

  /* Verifica o período inteiro, não só a retirada. */
  Cal.prototype.state = function (d) {
    if (d < this.first || this.inBlackout(d)) return 'blocked';
    for (var i = 0; i < this.days(); i++) {
      if (this.busy.indexOf(toISO(addDays(d, i))) !== -1) return 'busy';
    }
    return 'free';
  };

  Cal.prototype.weekdays = function () {
    var base = new Date(2024, 0, 7),
      h = '';
    for (var i = 0; i < 7; i++) {
      var l = addDays(base, i).toLocaleDateString(this.locale, { weekday: 'short' });
      h += '<span>' + l.replace('.', '').slice(0, 3) + '</span>';
    }
    this.e.weekdays.innerHTML = h;
  };

  Cal.prototype.render = function () {
    if (this.failed) {
      this.e.grid.innerHTML =
        '<div class="vsc-cal__loading">' + this.t('load_error') + '</div>';
      this.e.submit.disabled = true;
      this.status('error', this.t('load_error_help'));
      this.contact(true);
      return;
    }

    var y = this.view.getFullYear(),
      m = this.view.getMonth();
    this.e.month.textContent = this.view.toLocaleDateString(this.locale, {
      month: 'long',
      year: 'numeric'
    });

    var pad = new Date(y, m, 1).getDay(),
      total = new Date(y, m + 1, 0).getDate(),
      h = '',
      free = 0,
      i;

    for (i = 0; i < pad; i++) {
      h += '<span class="vsc-day vsc-day--pad" aria-hidden="true"></span>';
    }

    for (i = 1; i <= total; i++) {
      var d = new Date(y, m, i),
        st = this.state(d),
        c = ['vsc-day'];

      if (st === 'busy') c.push('vsc-day--busy');
      if (st === 'blocked') c.push('vsc-day--blocked');
      if (st === 'free') free++;
      if (sameDay(d, this.today)) c.push('vsc-day--today');

      if (this.sel) {
        var e = this.end(this.sel);
        if (sameDay(d, this.sel)) c.push('vsc-day--selected');
        else if (sameDay(d, e)) c.push('vsc-day--range', 'vsc-day--range-end');
        else if (d > this.sel && d < e) c.push('vsc-day--range');
      }

      var human = d.toLocaleDateString(this.locale, { day: 'numeric', month: 'long' });
      var aria =
        st === 'free' ? human : human + ' — ' + this.t(st === 'busy' ? 'busy' : 'unavailable');

      h +=
        '<button type="button" class="' + c.join(' ') + '" data-date="' + toISO(d) + '"' +
        (st === 'free' ? ' tabindex="0"' : ' disabled tabindex="-1"') +
        ' aria-label="' + aria + '">' + i + '</button>';
    }

    this.e.grid.innerHTML = h;
    this.e.grid.classList.remove('vsc-cal__grid--enter');
    void this.e.grid.offsetWidth;
    this.e.grid.classList.add('vsc-cal__grid--enter');
    this.e.prev.disabled = y === this.first.getFullYear() && m === this.first.getMonth();
    this.monthFree = free;
    this.summary();
  };

  Cal.prototype.summary = function () {
    var e = this.e;
    if (!this.sel) {
      e.sum.hidden = true;
      e.note.hidden = true;
      e.submit.disabled = true;
      /* Mês sem nenhum dia livre não é beco sem saída: é exatamente o caso
         que o cliente descreveu — alta temporada ou peça toda tomada, aí
         manda falar com o atendimento e a funcionária resolve na mão. */
      if (this.monthFree === 0) {
        this.status('warn', this.t('month_full'));
        this.contact(true);
      } else {
        this.status(this.demo ? 'warn' : null, this.demo ? this.t('demo_mode') : '');
        this.contact(false);
      }
      return;
    }
    var f = { day: '2-digit', month: 'short', year: 'numeric' },
      n = this.days();
    e.pickup.textContent = this.sel.toLocaleDateString(this.locale, f);
    e.ret.textContent = this.end(this.sel).toLocaleDateString(this.locale, f);
    e.period.textContent = n + ' ' + this.t(n === 1 ? 'day' : 'days');
    e.sum.hidden = false;
    e.note.textContent = this.t('duration_note').replace('{count}', String(this.pieces));
    e.note.hidden = false;
    e.submit.disabled = false;
    this.status('ok', this.t('available'));
    this.contact(false);
  };

  Cal.prototype.status = function (kind, text) {
    var el = this.e.status;
    if (!kind || !text) {
      el.hidden = true;
      return;
    }
    el.className = 'vsc-status vsc-status--' + kind;
    el.textContent = text;
    el.hidden = false;
  };

  Cal.prototype.contact = function (show) {
    var el = this.e.contact;
    if (!el) return;
    if (!show || !this.wa) {
      el.hidden = true;
      return;
    }
    el.href =
      'https://wa.me/' + this.wa + '?text=' +
      encodeURIComponent(
        this.t('whatsapp_message').replace('{product}', this.title).replace('{sku}', this.sku)
      );
    el.hidden = false;
  };

  Cal.prototype.moveFocus = function (iso, step) {
    var target = addDays(fromISO(iso), step);
    if (
      target.getMonth() !== this.view.getMonth() ||
      target.getFullYear() !== this.view.getFullYear()
    ) {
      this.view = new Date(target.getFullYear(), target.getMonth(), 1);
      this.render();
    }
    var next = this.e.grid.querySelector('[data-date="' + toISO(target) + '"]');
    if (next) next.focus();
  };

  /* Line item properties, não cart attributes — ver README. */
  Cal.prototype.submit = function () {
    if (!this.sel) return;
    var s = this,
      end = this.end(this.sel),
      p = {};

    this.e.submit.disabled = true;
    this.e.spin.hidden = false;

    p[this.t('prop_pickup')] = this.sel.toLocaleDateString(this.locale);
    p[this.t('prop_return')] = end.toLocaleDateString(this.locale);
    p._vsc_pickup = toISO(this.sel);
    p._vsc_return = toISO(end);
    p._vsc_sku = this.sku;

    fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: [{ id: this.variantId, quantity: 1, properties: p }] })
    })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        window.location.href = '/cart';
      })
      .catch(function () {
        s.e.submit.disabled = false;
        s.e.spin.hidden = true;
        s.status('error', s.t('cart_error'));
      });
  };

  function boot(scope) {
    (scope || document).querySelectorAll('[data-vsc-rental]').forEach(function (el) {
      if (!el.dataset.vscReady) {
        el.dataset.vscReady = '1';
        new Cal(el);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      boot();
    });
  } else {
    boot();
  }

  /* O editor de tema recarrega só a seção — sem isto o calendário some
     quando o cliente mexe numa cor. */
  document.addEventListener('shopify:section:load', function (e) {
    boot(e.target);
  });
})();
