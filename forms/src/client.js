// The script a client site loads: <script src="https://forms.10xid.com/embed.js?site=KEY" defer>.
//
// The sites are static copies of WordPress sites, and their forms are the
// WordPress forms copied as markup: Elementor, Divi and eForm (FSQM). Those
// forms still try to post to WordPress. This script takes them over instead:
//   - it hides the copied reCAPTCHA and puts a Turnstile check in its place
//   - on submit it stops the copied WordPress script, checks the fields, and
//     sends the form's labels and answers to the forms Worker
//   - it says on the page whether the form was sent.
// Forms that are not enquiries are left alone: search, log in, cart.
//
// The Worker serves this file with __TENX_CONFIG__ replaced by the site's
// settings (index.js). It is plain browser JavaScript, not bundled.
(function (cfg) {
  'use strict';
  if (!cfg || window.__tenxForms) return;
  // Also lets anyone check, from the browser console, what a form would send:
  // __tenxForms.fields(document.forms[0]).
  window.__tenxForms = { site: cfg.site, fields: function (form) { return fields(form); } };

  var CAPTCHA = '.elementor-field-type-recaptcha, .elementor-field-type-recaptcha_v3, .elementor-g-recaptcha, ' +
    // Divi's sum captcha lives in .et_pb_contact_right, and nothing else does.
    '.g-recaptcha, .grecaptcha-badge, .ipt_uif_recaptcha, .et_pb_contact_right';
  var GROUP = '.elementor-field-group, .et_pb_contact_field, .ipt_uif_question, .form-group, .gfield, .wpforms-field, p';
  var NOT_ENQUIRY = '[role=search], .search-form, .woocommerce-form, .woocommerce-ResetPassword, form.cart, ' +
    'form.variations_form, .et-search-form, [data-tenx-forms=off]';

  var style = document.createElement('style');
  style.textContent = CAPTCHA + '{display:none!important}' +
    '.tenx-turnstile{flex:0 0 100%;width:100%;max-width:100%;margin:0 0 12px;min-height:0}' +
    '.tenx-status{flex:0 0 100%;width:100%;margin:12px 0 0;font-size:15px;line-height:1.4}' +
    '.tenx-status:empty{display:none}' +
    '.tenx-status.is-ok{color:#1b6e2d}.tenx-status.is-error{color:#b3261e}' +
    '[aria-invalid=true]{outline:2px solid #b3261e!important;outline-offset:1px}' +
    '.tenx-hp{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}';
  document.head.appendChild(style);

  function isEnquiry(form) {
    if (!(form instanceof HTMLFormElement)) return false;
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'post') return false;
    if (form.matches(NOT_ENQUIRY) || form.querySelector('input[type=password]')) return false;
    return !!form.querySelector('input[type=email], input[type=tel], textarea');
  }

  function clean(text) {
    return String(text || '').replace(/\s+/g, ' ').replace(/[\s*:]+$/, '').trim();
  }

  // The question a field answers: its group's label first (copied forms often
  // repeat the same id on two forms, so `for=` can point at the wrong one),
  // then its own label, then whatever the field says about itself.
  function labelFor(el) {
    var group = el.closest(GROUP);
    if (group && group.closest('form') === el.form) {
      var labels = group.querySelectorAll('.ipt_uif_question_label, label, legend');
      for (var i = 0; i < labels.length; i++) {
        var l = labels[i];
        if (l.contains(el) || (el.id && l.htmlFor === el.id && (el.type === 'radio' || el.type === 'checkbox'))) continue;
        // eForm puts the question, a required star, then a help line in one
        // label: keep the question.
        var t = clean(clean(l.textContent).split('*')[0]) || clean(l.textContent);
        if (t) return t;
      }
    }
    if (el.labels && el.labels[0] && !(el.type === 'radio' || el.type === 'checkbox')) {
      var own = clean(el.labels[0].textContent);
      if (own) return own;
    }
    // A drop-down with no label often asks its question in a blank first
    // option: "How did you hear about us?".
    if (el.tagName === 'SELECT' && el.options[0] && !el.options[0].value) {
      var ask = clean(el.options[0].text).replace(/\?$/, '?');
      if (ask && !/^(select|choose|--)/i.test(ask)) return ask;
    }
    return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-original_id') ||
      el.name.replace(/^form_fields\[|\]$/g, '').replace(/[_\[\]]+/g, ' '));
  }

  // What a ticked box or chosen option says, not its value (often a number).
  function optionText(el) {
    var l = el.labels && el.labels[0];
    var t = l && clean(l.textContent);
    if (!t && l) {
      var img = l.querySelector('img[alt]');
      t = clean((img && img.alt) || l.title);
    }
    return t || clean(el.title) || el.value;
  }

  function fields(form) {
    var out = [], at = {};
    var els = form.querySelectorAll('input, select, textarea');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = (el.type || '').toLowerCase();
      if (!el.name || el.disabled) continue;
      if (/^(hidden|submit|button|reset|password|file|image)$/.test(type)) continue;
      if (/recaptcha|turnstile|nonce|^_tenx|^et_pb_contactform_submit|^et_pb_contact_captcha/i.test(el.name)) continue;
      if (el.closest('.elementor-field-type-honeypot, .tenx-hp')) continue;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      var value;
      if (el.tagName === 'SELECT') {
        value = Array.prototype.map.call(el.selectedOptions, function (o) { return clean(o.text); }).join(', ');
      } else if (type === 'checkbox' || type === 'radio') {
        value = optionText(el);
      } else {
        value = el.value;
      }
      value = String(value || '').trim();
      if (!value) continue;
      var key = el.name.replace(/\[\]$/, '');
      if (at[key] != null) { out[at[key]].value += ', ' + value; continue; }
      at[key] = out.length;
      out.push({ label: labelFor(el).slice(0, 200), value: value.slice(0, 5000), type: type || el.tagName.toLowerCase() });
    }
    return out;
  }

  function isRequired(el) {
    var group = el.closest(GROUP);
    return el.required || el.getAttribute('aria-required') === 'true' ||
      /validate\[[^\]]*required/.test(el.className) || el.getAttribute('data-required_mark') === 'required' ||
      !!(group && /elementor-field-required/.test(group.className));
  }

  function shown(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // The copied scripts that would have checked the form no longer run, so the
  // form is checked here. eForm (FSQM) brings its own validator: use it.
  function valid(form) {
    var $ = window.jQuery;
    if ($ && $.fn && $.fn.validationEngine && /ipt_uif_validate_form/.test(form.className)) {
      try { return $(form).validationEngine('validate') !== false; } catch (e) { /* fall through */ }
    }
    var first = null, groups = {};
    var els = form.querySelectorAll('input, select, textarea');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = (el.type || '').toLowerCase();
      if (el.disabled || /^(hidden|submit|button|reset|file|image)$/.test(type) || !shown(el)) continue;
      el.removeAttribute('aria-invalid');
      if (type === 'checkbox' || type === 'radio') {
        if (!isRequired(el)) continue;
        groups[el.name] = groups[el.name] || { el: el, ok: false };
        if (el.checked) groups[el.name].ok = true;
        continue;
      }
      var v = String(el.value || '').trim();
      var bad = (isRequired(el) && !v) ||
        (v && (type === 'email' || el.getAttribute('data-field_type') === 'email') && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v));
      if (bad) { el.setAttribute('aria-invalid', 'true'); first = first || el; }
    }
    for (var name in groups) {
      if (!groups[name].ok) { groups[name].el.setAttribute('aria-invalid', 'true'); first = first || groups[name].el; }
    }
    if (first) { try { first.focus(); } catch (e) { /* ignore */ } }
    return !first;
  }

  function submitButton(form) {
    var all = form.querySelectorAll('button[type=submit], input[type=submit], button:not([type])');
    return all[all.length - 1] || null;
  }

  // Where the Turnstile check and the status line go: just before and just
  // after the submit button's own row, so the copied layout keeps its shape.
  function submitRow(form) {
    var btn = submitButton(form);
    if (!btn) return null;
    var row = btn.closest('.elementor-field-type-submit, .et_contact_bottom_container, .ipt_fsqm_form_button_container, .ipt_uif_button_container');
    return row && form.contains(row) ? row : btn;
  }

  var forms = [];
  function setUp(form) {
    if (form.__tenx) return form.__tenx;
    var row = submitRow(form);
    var slot = document.createElement('div');
    slot.className = 'tenx-turnstile';
    var status = document.createElement('div');
    status.className = 'tenx-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var hp = document.createElement('div');
    hp.className = 'tenx-hp';
    hp.setAttribute('aria-hidden', 'true');
    hp.innerHTML = '<label>Leave this empty <input type="text" name="_tenx_hp" tabindex="-1" autocomplete="off"></label>';
    if (row && row.parentNode) {
      row.parentNode.insertBefore(slot, row);
      row.parentNode.insertBefore(status, row.nextSibling);
    } else {
      form.appendChild(slot);
      form.appendChild(status);
    }
    form.appendChild(hp);
    var state = { slot: slot, status: status, hp: hp.querySelector('input'), widget: null, token: null, waiters: [], busy: false };
    form.__tenx = state;
    forms.push(form);
    render(form);
    return state;
  }

  function render(form) {
    var s = form.__tenx;
    if (!window.turnstile || s.widget != null) return;
    s.widget = window.turnstile.render(s.slot, {
      sitekey: cfg.sitekey,
      appearance: 'interaction-only',
      'refresh-expired': 'auto',
      callback: function (token) {
        s.token = token;
        var w = s.waiters; s.waiters = [];
        w.forEach(function (fn) { fn(token); });
      },
      'expired-callback': function () { s.token = null; },
      'error-callback': function () { s.token = null; },
    });
  }

  window.__tenxTurnstileReady = function () { forms.forEach(render); };

  // The token, once the check has passed: at most 20 seconds' wait.
  function token(s) {
    if (s.token) return Promise.resolve(s.token);
    return new Promise(function (resolve) {
      s.waiters.push(resolve);
      setTimeout(function () { resolve(s.token); }, 20000);
    });
  }

  function say(s, text, ok) {
    s.status.textContent = text;
    s.status.className = 'tenx-status ' + (ok ? 'is-ok' : 'is-error');
  }

  // The form's own name (Elementor names its forms), else the title of the
  // block it sits in (Divi), else the page's main heading.
  function formName(form) {
    var named = form.getAttribute('name') || form.getAttribute('aria-label');
    if (!named) {
      var box = form.closest('.et_pb_contact_form_container, .ipt_fsqm_main_wrap, .elementor-widget');
      var title = box && box.querySelector('.et_pb_contact_main_title, .ipt_fsqm_form_name, h1, h2, h3');
      var h1 = document.querySelector('h1');
      named = (title && title.textContent) || (h1 && h1.textContent) || 'Contact form';
    }
    return clean(named).slice(0, 120);
  }

  function send(form) {
    var s = setUp(form);
    if (s.busy) return;
    s.status.textContent = '';
    if (!valid(form)) { say(s, 'Please fill in the highlighted fields.', false); return; }
    var btn = submitButton(form);
    s.busy = true;
    if (btn) btn.disabled = true;
    say(s, 'Sending…', true);
    token(s).then(function (t) {
      if (!t) throw new Error('Please complete the security check above, then send the form again.');
      return fetch(cfg.endpoint, {
        method: 'POST',
        // text/plain keeps this a simple request: no preflight round trip.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ form: formName(form), page: location.href, fields: fields(form), token: t, hp: s.hp.value }),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok || !body.ok) throw new Error(body.message || 'Sorry, that could not be sent. Please try again, or call or email us directly.');
          return body;
        });
      });
    }).then(function (body) {
      form.reset();
      say(s, body.message || 'Thank you. Your message has been sent.', true);
      if (cfg.thanks) location.assign(cfg.thanks);
    }, function (err) {
      say(s, (err && err.message) || 'Sorry, that could not be sent. Please try again.', false);
    }).then(function () {
      s.busy = false;
      s.token = null;
      if (btn) btn.disabled = false;
      if (window.turnstile && s.widget != null) window.turnstile.reset(s.widget);
    });
  }

  // Capture phase on the document runs before the copied form scripts, which
  // listen on the form itself or further up. Stopping the event there means
  // they never post the form to the old WordPress site.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!isEnquiry(form)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    send(form);
  }, true);

  function start() {
    var all = document.querySelectorAll(CAPTCHA);
    for (var i = 0; i < all.length; i++) all[i].parentNode && all[i].parentNode.removeChild(all[i]);
    var list = document.querySelectorAll('form');
    for (var j = 0; j < list.length; j++) if (isEnquiry(list[j])) setUp(list[j]);
    if (!forms.length) return;
    var ts = document.createElement('script');
    ts.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tenxTurnstileReady';
    ts.async = true;
    document.head.appendChild(ts);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(__TENX_CONFIG__);
