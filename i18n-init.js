// PEPMASTERS — Sistema de internacionalização
(function() {
  'use strict';

  const LANGS = {
    en: { label: 'EN', flag: '<svg viewBox="0 0 20 15" width="20" height="15"><rect width="20" height="15" fill="#012169"/><path d="M0,0 L20,15 M20,0 L0,15" stroke="#fff" stroke-width="3"/><path d="M0,0 L20,15 M20,0 L0,15" stroke="#C8102E" stroke-width="2"/><path d="M10,0 V15 M0,7.5 H20" stroke="#fff" stroke-width="5"/><path d="M10,0 V15 M0,7.5 H20" stroke="#C8102E" stroke-width="3"/></svg>' },
    pt: { label: 'PT', flag: '<svg viewBox="0 0 20 15" width="20" height="15"><rect width="20" height="15" fill="#009C3B"/><rect x="7" width="13" height="15" fill="#FFDF00"/><circle cx="10" cy="7.5" r="3" fill="#002776"/></svg>' },
    es: { label: 'ES', flag: '<svg viewBox="0 0 20 15" width="20" height="15"><rect width="20" height="15" fill="#c60b1e"/><rect y="3.75" width="20" height="7.5" fill="#ffc400"/></svg>' },
    de: { label: 'DE', flag: '<svg viewBox="0 0 20 15" width="20" height="15"><rect width="20" height="5" fill="#000"/><rect y="5" width="20" height="5" fill="#D00"/><rect y="10" width="20" height="5" fill="#FFCE00"/></svg>' },
    fr: { label: 'FR', flag: '<svg viewBox="0 0 20 15" width="20" height="15"><rect width="7" height="15" fill="#002395"/><rect x="7" width="6" height="15" fill="#fff"/><rect x="13" width="7" height="15" fill="#ED2939"/></svg>' },
  };

  function getLang() { return localStorage.getItem('pep_lang') || 'en'; }

  function setLang(lang) {
    localStorage.setItem('pep_lang', lang);
    applyTranslations(lang);
    updateSelector(lang);
    // Recarregar FAQ se existir
    if (typeof renderFaq === 'function') renderFaq();
  }

  function applyTranslations(lang) {
    var dict = window.PEPMASTERS_I18N || {};
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      if (dict[key] && dict[key][lang]) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.placeholder = dict[key][lang];
        } else {
          el.textContent = dict[key][lang];
        }
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
      var key = el.getAttribute('data-i18n-placeholder');
      if (dict[key] && dict[key][lang]) el.placeholder = dict[key][lang];
    });
    document.documentElement.lang = lang;
  }

  function updateSelector(lang) {
    var btn = document.getElementById('langBtn');
    if (btn && LANGS[lang]) {
      btn.innerHTML = LANGS[lang].flag + '<span style="margin-left:4px">' + LANGS[lang].label + '</span><svg width="10" height="6" viewBox="0 0 10 6" fill="none" style="margin-left:3px"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    }
    document.querySelectorAll('.lang-option').forEach(function(opt) {
      opt.style.background = opt.getAttribute('data-lang') === lang ? '#FFF3D0' : '';
      opt.style.fontWeight  = opt.getAttribute('data-lang') === lang ? '900' : '700';
    });
  }

  function criarSeletor() {
    // Funciona em qualquer header — insere no final do header
    var header = document.querySelector('header');
    if (!header || document.getElementById('langSelector')) return;

    var wrapper = document.createElement('div');
    wrapper.id = 'langSelector';
    wrapper.style.cssText = 'position:relative;display:flex;align-items:center;margin-left:auto;flex-shrink:0';

    var btn = document.createElement('button');
    btn.id = 'langBtn';
    btn.style.cssText = 'display:flex;align-items:center;gap:4px;padding:6px 10px;border:2px solid #FFD580;border-radius:8px;background:none;cursor:pointer;font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:.85rem;letter-spacing:.04em;color:#3D1A00;transition:all .2s;white-space:nowrap';
    btn.setAttribute('aria-label', 'Select language');

    var dropdown = document.createElement('div');
    dropdown.id = 'langDropdown';
    dropdown.style.cssText = 'display:none;position:absolute;top:calc(100% + 6px);right:0;background:#FFFDF9;border:2px solid #FFD580;border-radius:10px;min-width:120px;box-shadow:0 8px 24px rgba(232,34,10,.12);overflow:hidden;z-index:9999';

    Object.entries(LANGS).forEach(function(entry) {
      var code = entry[0], info = entry[1];
      var opt = document.createElement('button');
      opt.className = 'lang-option';
      opt.setAttribute('data-lang', code);
      opt.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;padding:9px 14px;background:none;border:none;cursor:pointer;font-family:"Barlow Condensed",sans-serif;font-weight:700;font-size:.9rem;color:#3D1A00;text-align:left;transition:background .15s';
      opt.innerHTML = info.flag + '<span>' + info.label + '</span>';
      opt.onmouseenter = function() { if (this.getAttribute('data-lang') !== getLang()) this.style.background = '#FFF3D0'; };
      opt.onmouseleave = function() { if (this.getAttribute('data-lang') !== getLang()) this.style.background = ''; };
      opt.onclick = function(e) {
        e.stopPropagation();
        setLang(code);
        dropdown.style.display = 'none';
      };
      dropdown.appendChild(opt);
    });

    btn.onclick = function(e) {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', function() { dropdown.style.display = 'none'; });

    wrapper.appendChild(btn);
    wrapper.appendChild(dropdown);

    // Inserir: se tiver .header-inner, coloca dentro; senão no header direto
    var inner = header.querySelector('.header-inner');
    var authArea = document.getElementById('authArea');
    if (authArea) {
      authArea.parentNode.insertBefore(wrapper, authArea);
    } else if (inner) {
      inner.appendChild(wrapper);
    } else {
      header.appendChild(wrapper);
    }
  }

  // API global
  window.PEP_LANG = {
    get: getLang,
    set: setLang,
    t: function(key) {
      var lang = getLang();
      var dict = window.PEPMASTERS_I18N || {};
      return (dict[key] && dict[key][lang]) || (dict[key] && dict[key]['en']) || key;
    }
  };

  function init() {
    criarSeletor();
    var lang = getLang();
    applyTranslations(lang);
    updateSelector(lang);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
