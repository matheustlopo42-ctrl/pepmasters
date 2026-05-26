// PEPMASTERS i18n-init.js
(function() {
  'use strict';

  var LANGS = {
    en: { label: 'EN', flag: '<svg viewBox="0 0 20 15" width="18" height="14"><rect width="20" height="15" fill="#012169"/><path d="M0,0 L20,15 M20,0 L0,15" stroke="#fff" stroke-width="3"/><path d="M0,0 L20,15 M20,0 L0,15" stroke="#C8102E" stroke-width="2"/><path d="M10,0 V15 M0,7.5 H20" stroke="#fff" stroke-width="5"/><path d="M10,0 V15 M0,7.5 H20" stroke="#C8102E" stroke-width="3"/></svg>' },
    pt: { label: 'PT', flag: '<svg viewBox="0 0 20 15" width="18" height="14"><rect width="20" height="15" fill="#009C3B"/><rect x="7" width="13" height="15" fill="#FFDF00"/><circle cx="10" cy="7.5" r="3" fill="#002776"/></svg>' },
    es: { label: 'ES', flag: '<svg viewBox="0 0 20 15" width="18" height="14"><rect width="20" height="15" fill="#c60b1e"/><rect y="3.75" width="20" height="7.5" fill="#ffc400"/></svg>' },
    de: { label: 'DE', flag: '<svg viewBox="0 0 20 15" width="18" height="14"><rect width="20" height="5" fill="#000"/><rect y="5" width="20" height="5" fill="#D00"/><rect y="10" width="20" height="5" fill="#FFCE00"/></svg>' },
    fr: { label: 'FR', flag: '<svg viewBox="0 0 20 15" width="18" height="14"><rect width="7" height="15" fill="#002395"/><rect x="7" width="6" height="15" fill="#fff"/><rect x="13" width="7" height="15" fill="#ED2939"/></svg>' },
  };

  function getLang() { return localStorage.getItem('pep_lang') || 'en'; }

  function setLang(lang) {
    localStorage.setItem('pep_lang', lang);
    apply(lang);
    updateBtn(lang);
    if (typeof window.renderFaq === 'function') window.renderFaq();
  }

  function apply(lang) {
    var dict = window.PEPMASTERS_I18N;
    if (!dict) return;
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      var val = dict[key] && (dict[key][lang] || dict[key]['en']);
      if (!val) return;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.placeholder = val;
      } else {
        el.textContent = val;
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-placeholder');
      var val = dict[key] && (dict[key][lang] || dict[key]['en']);
      if (val) el.placeholder = val;
    });
    document.documentElement.lang = lang;
  }

  function updateBtn(lang) {
    var btn = document.getElementById('langBtn');
    if (btn && LANGS[lang]) {
      btn.innerHTML = LANGS[lang].flag +
        '<span style="margin-left:5px;letter-spacing:.04em">' + LANGS[lang].label + '</span>' +
        '<svg width="9" height="5" viewBox="0 0 10 6" fill="none" style="margin-left:3px"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    document.querySelectorAll('.lang-opt').forEach(function(o) {
      o.style.background = o.getAttribute('data-lang') === lang ? '#FFF3D0' : '';
    });
  }

  function buildSelector() {
    if (document.getElementById('langSelector')) return;
    var header = document.querySelector('header');
    if (!header) return;

    var wrap = document.createElement('div');
    wrap.id = 'langSelector';
    wrap.style.cssText = 'position:relative;display:flex;align-items:center;flex-shrink:0;z-index:500';

    var btn = document.createElement('button');
    btn.id = 'langBtn';
    btn.style.cssText = [
      'display:flex','align-items:center','gap:3px',
      'padding:5px 10px','border:2px solid #FFD580','border-radius:8px',
      'background:none','cursor:pointer',
      'font-family:"Barlow Condensed",sans-serif','font-weight:700',
      'font-size:.85rem','color:#3D1A00','transition:border-color .2s',
      'white-space:nowrap'
    ].join(';');

    var dd = document.createElement('div');
    dd.id = 'langDropdown';
    dd.style.cssText = [
      'display:none','position:absolute','top:calc(100% + 6px)','right:0',
      'background:#FFFDF9','border:2px solid #FFD580','border-radius:10px',
      'min-width:110px','box-shadow:0 8px 24px rgba(232,34,10,.15)',
      'overflow:hidden','z-index:9999'
    ].join(';');

    Object.keys(LANGS).forEach(function(code) {
      var info = LANGS[code];
      var opt = document.createElement('button');
      opt.className = 'lang-opt';
      opt.setAttribute('data-lang', code);
      opt.style.cssText = [
        'display:flex','align-items:center','gap:8px','width:100%',
        'padding:9px 14px','background:none','border:none','cursor:pointer',
        'font-family:"Barlow Condensed",sans-serif','font-weight:700',
        'font-size:.9rem','color:#3D1A00','transition:background .15s'
      ].join(';');
      opt.innerHTML = info.flag + '<span>' + info.label + '</span>';
      opt.onmouseenter = function() { this.style.background = '#FFF3D0'; };
      opt.onmouseleave = function() {
        this.style.background = this.getAttribute('data-lang') === getLang() ? '#FFF3D0' : '';
      };
      opt.onclick = function(e) {
        e.stopPropagation();
        setLang(code);
        dd.style.display = 'none';
      };
      dd.appendChild(opt);
    });

    btn.onclick = function(e) {
      e.stopPropagation();
      dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', function() { dd.style.display = 'none'; });

    wrap.appendChild(btn);
    wrap.appendChild(dd);

    // Inserir no lugar certo
    var authArea = document.getElementById('authArea');
    var inner    = header.querySelector('.header-inner');
    if (authArea) {
      authArea.parentNode.insertBefore(wrap, authArea);
    } else if (inner) {
      inner.appendChild(wrap);
    } else {
      header.style.display    = header.style.display || 'flex';
      header.style.alignItems = 'center';
      header.appendChild(wrap);
    }
  }

  // API global
  window.PEP_LANG = {
    get: getLang,
    set: setLang,
    t: function(key) {
      var lang = getLang();
      var d = window.PEPMASTERS_I18N || {};
      return (d[key] && (d[key][lang] || d[key]['en'])) || key;
    }
  };

  // Aguardar dicionário e DOM
  function waitAndInit() {
    var lang = getLang();
    buildSelector();
    updateBtn(lang);
    if (window.PEPMASTERS_I18N) {
      apply(lang);
    } else {
      // Retry até 20x com 50ms de intervalo
      var tries = 0;
      var iv = setInterval(function() {
        tries++;
        if (window.PEPMASTERS_I18N) {
          apply(getLang());
          clearInterval(iv);
        } else if (tries >= 20) {
          clearInterval(iv);
        }
      }, 50);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitAndInit);
  } else {
    waitAndInit();
  }

})();
