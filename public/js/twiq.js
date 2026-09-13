/* ==========================================================================
   Twiq - progressive enhancement
   --------------------------------------------------------------------------
   Every feature on this site works as a plain HTML form submission. This
   file only makes those interactions feel immediate: it intercepts a form,
   posts it in the background and updates the markup that is already on the
   page. If it fails - or never loads - the browser submits the form and the
   server renders the same result.
   ========================================================================== */
(function () {
  'use strict';

  var body = document.body;
  var CSRF = body.getAttribute('data-csrf') || '';
  // The server owns the limit; the counter just reads it off the document.
  var MAX_TWEET = parseInt(body.getAttribute('data-tweet-max'), 10) || 300;

  function $(selector, scope) { return (scope || document).querySelector(selector); }
  function $$(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  function post(url, data) {
    var options = {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': CSRF, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' }
    };
    if (data instanceof FormData) {
      // Only genuine file uploads are sent as multipart; everything else goes
      // out form-encoded, which is what the server's body parser expects.
      var hasFile = false;
      data.forEach(function (value) {
        if (typeof File !== 'undefined' && value instanceof File && value.size > 0) hasFile = true;
      });
      if (hasFile) {
        options.body = data;
      } else {
        options.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        options.body = new URLSearchParams(data).toString();
      }
    } else if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(data);
    }
    return fetch(url, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var error = new Error((payload.error && payload.error.message) || 'Request failed');
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function getJson(url) {
    return fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); });
  }

  function getHtml(url) {
    return fetch(url, {
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); });
  }

  function announce(message) {
    var region = $('#twiq-live');
    if (!region) {
      region = document.createElement('div');
      region.id = 'twiq-live';
      region.className = 'visually-hidden';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    region.textContent = message;
  }

  /* --------------------------------------------------------- loading --- */
  /**
   * One mechanism for everything that waits: a progress bar for navigations,
   * a busy state for controls, and a minimum visible time so an indicator
   * that appears at all is actually seen rather than strobing.
   */
  var MIN_INDICATOR_MS = 320;

  var progress = (function () {
    var el = $('[data-nav-progress]');
    var bar = el && el.firstElementChild;
    var creep = null;
    var at = 0;

    function set(percent) {
      at = percent;
      if (bar) bar.style.width = percent + '%';
    }

    return {
      start: function () {
        if (!el || el.classList.contains('is-active')) return;
        el.classList.add('is-active');
        set(0);
        // Jump to a visible amount, then creep - never reaching the end,
        // because only the reply knows when it is done.
        window.setTimeout(function () { set(28); }, 10);
        creep = window.setInterval(function () {
          if (at < 88) set(at + (88 - at) * 0.18);
        }, 220);
      },
      done: function () {
        if (!el || !el.classList.contains('is-active')) return;
        window.clearInterval(creep);
        set(100);
        window.setTimeout(function () {
          el.classList.remove('is-active');
          window.setTimeout(function () { set(0); }, 200);
        }, 180);
      },
    };
  }());

  /** Resolve no sooner than `ms`, so a spinner never flashes and vanishes. */
  function atLeast(promise, ms) {
    var waited = new Promise(function (resolve) { window.setTimeout(resolve, ms || MIN_INDICATOR_MS); });
    return Promise.all([promise, waited]).then(function (pair) { return pair[0]; });
  }

  /** Put a control into its busy state; returns the undo. */
  function busy(el) {
    if (!el) return function () {};
    var wasDisabled = el.disabled;
    el.classList.add('is-busy');
    if ('disabled' in el) el.disabled = true;
    el.setAttribute('aria-busy', 'true');
    return function () {
      el.classList.remove('is-busy');
      if ('disabled' in el) el.disabled = wasDisabled;
      el.removeAttribute('aria-busy');
    };
  }

  /** Dim a region while its replacement is being fetched. */
  function dim(el) {
    if (!el) return function () {};
    el.classList.add('is-loading');
    return function () { el.classList.remove('is-loading'); };
  }

  // -- navigations ------------------------------------------------------
  // The request is never delayed. The bar covers the wait, and the incoming
  // page animates itself in, which is where the sense of movement comes from.
  var INTERCEPTED = '[data-lightbox],[data-load-more],[data-copy-link],[data-compose-open],' +
    '[data-wtf-refresh],[data-menu-toggle],[data-composer-open],[data-trend-scope-toggle],' +
    '[data-dm-new-toggle],[data-compose-modal-close]';

  function leavesPage(link) {
    if (!link || !link.href) return false;
    if (link.target && link.target !== '_self') return false;
    if (link.hasAttribute('download') || link.getAttribute('rel') === 'external') return false;
    if (link.closest(INTERCEPTED) || link.matches(INTERCEPTED)) return false;
    var url;
    try { url = new URL(link.href, window.location.href); } catch (err) { return false; }
    if (url.origin !== window.location.origin) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // A jump within this page is not a navigation.
    return !(url.pathname === window.location.pathname && url.search === window.location.search && url.hash);
  }

  var leaveTimer = null;
  function beginNavigation() {
    progress.start();
    body.classList.add('is-leaving');
    // If the navigation never happens - the reader hits Escape, or the
    // server never answers - the page must not stay dimmed for ever.
    window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(cancelNavigation, 8000);
  }

  function cancelNavigation() {
    window.clearTimeout(leaveTimer);
    body.classList.remove('is-leaving');
    progress.done();
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest('a');
    if (leavesPage(link)) return beginNavigation();
    openTweetFromText(event);
  });

  /**
   * Clicking the body of a Tweet opens it. The mentions, hashtags and links
   * inside it keep their own destinations, and a click that was really a
   * text selection is left alone - otherwise copying a line would navigate.
   */
  function openTweetFromText(event) {
    var text = event.target.closest('[data-open-tweet]');
    if (!text) return;
    if (event.target.closest('a, button, input, textarea, label, video, form')) return;
    var selection = window.getSelection && window.getSelection();
    if (selection && String(selection).length > 0) return;
    var href = text.getAttribute('data-open-tweet');
    if (!href) return;
    beginNavigation();
    window.location.href = href;
  }

  document.addEventListener('submit', function (event) {
    if (event.defaultPrevented) return;
    var form = event.target;
    // Forms handled in the page keep their own indicator instead.
    if (form.matches('[data-compose-form],[data-inline-reply],[data-interaction],' +
                     '[data-follow-form],[data-dm-form],[data-typeahead]')) return;
    beginNavigation();
  });

  // Coming back through the cache must not leave the page dimmed.
  window.addEventListener('pageshow', cancelNavigation);

  /* ------------------------------------------------------------- menus --- */
  function closeMenus(except) {
    $$('.menu.is-open').forEach(function (menu) {
      if (menu === except) return;
      menu.classList.remove('is-open');
      var toggle = $('[data-menu-toggle]', menu);
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-menu-toggle]');
    if (toggle) {
      event.preventDefault();
      var menu = toggle.closest('.menu');
      var isOpen = menu.classList.contains('is-open');
      closeMenus(menu);
      menu.classList.toggle('is-open', !isOpen);
      toggle.setAttribute('aria-expanded', String(!isOpen));
      return;
    }
    if (!event.target.closest('.menu-panel')) closeMenus();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      cancelNavigation();
      closeMenus();
      closeLightbox();
      closeComposeModal();
      var open = $('.typeahead.is-open');
      if (open) open.classList.remove('is-open');
    }
  });

  /* --------------------------------------------------------- confirm --- */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) event.preventDefault();
  }, true);

  /* ------------------------------------------------------- copy link --- */
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy-link]');
    if (!button) return;
    event.preventDefault();
    var value = button.getAttribute('data-copy-link');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () {
        button.textContent = 'Link copied';
        announce('Link copied to the clipboard.');
        setTimeout(function () { button.textContent = 'Copy link to Tweet'; }, 1600);
      });
    } else {
      window.prompt('Copy this link', value);
    }
  });

  /* -------------------------------------------------- character count --- */
  function countCharacters(value) { return Array.from(String(value || '').trim()).length; }

  function wireCounter(input, counter, submit, limit) {
    if (!input || !counter) return;
    function update() {
      var used = countCharacters(input.value);
      var left = limit - used;
      counter.textContent = String(left);
      counter.classList.toggle('is-warning', left <= 20 && left >= 0);
      counter.classList.toggle('is-over', left < 0);
      if (submit) {
        var hasMedia = false;
        var form = input.form;
        if (form) {
          var ids = $('[data-media-ids]', form);
          hasMedia = Boolean(ids && ids.value);
        }
        submit.disabled = (used === 0 && !hasMedia) || left < 0;
      }
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 220) + 'px';
    }
    input.addEventListener('input', update);
    update();
  }

  /* ----------------------------------------------------- the composer --- */
  $$('[data-composer]').forEach(function (composer) {
    var opener = $('[data-composer-open]', composer);
    var input = $('[data-compose-input]', composer);
    var counter = $('[data-counter]', composer);
    var submit = $('[data-compose-submit]', composer);
    var mediaButton = $('[data-media-button]', composer);
    var mediaInput = $('[data-media-input]', composer);
    var mediaPreview = $('[data-media-preview]', composer);
    var mediaIds = $('[data-media-ids]', composer);

    function expand() {
      composer.classList.add('is-expanded');
      if (opener) opener.setAttribute('aria-expanded', 'true');
      if (input) input.focus();
    }

    if (opener) {
      opener.addEventListener('click', expand);
      opener.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); expand(); }
      });
    }

    wireCounter(input, counter, submit, MAX_TWEET);

    if (input) {
      input.addEventListener('keydown', function (event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && submit && !submit.disabled) {
          submit.form.requestSubmit ? submit.form.requestSubmit() : submit.click();
        }
      });
    }

    if (mediaButton && mediaInput) {
      mediaButton.addEventListener('click', function () { mediaInput.click(); });
      mediaInput.addEventListener('change', function () {
        var file = mediaInput.files && mediaInput.files[0];
        if (!file) return;
        var data = new FormData();
        data.append('media', file);
        mediaButton.disabled = true;
        post('/media', data)
          .then(function (payload) {
            var current = mediaIds.value ? mediaIds.value.split(',') : [];
            current.push(String(payload.media.id));
            mediaIds.value = current.join(',');
            var figure = document.createElement('figure');
            var thumb = document.createElement(payload.media.isVideo ? 'video' : 'img');
            thumb.src = payload.media.url;
            if (!payload.media.isVideo) thumb.alt = 'Attached media';
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.setAttribute('aria-label', 'Remove this attachment');
            remove.addEventListener('click', function () {
              mediaIds.value = mediaIds.value.split(',')
                .filter(function (id) { return id !== String(payload.media.id); }).join(',');
              figure.remove();
              if (input) input.dispatchEvent(new Event('input'));
            });
            figure.appendChild(thumb);
            figure.appendChild(remove);
            mediaPreview.appendChild(figure);
            mediaInput.value = '';
            if (input) input.dispatchEvent(new Event('input'));
          })
          .catch(function (err) { window.alert(err.message); })
          .then(function () { mediaButton.disabled = false; });
      });
    }

    var form = $('[data-compose-form]', composer);
    if (form) {
      form.addEventListener('submit', function (event) {
        if (!window.fetch) return;
        event.preventDefault();
        var restore = busy(submit);
        var data = new FormData(form);
        var inModal = Boolean(composer.closest('[data-compose-modal]'));
        atLeast(post('/tweets', data))
          .then(function (payload) {
            var stream = $('[data-stream]');
            if (stream && payload.html && !data.get('in_reply_to')) {
              var wrapper = document.createElement('div');
              wrapper.innerHTML = payload.html;
              var node = wrapper.firstElementChild;
              if (node) stream.insertBefore(node, stream.firstChild);
              if (input) input.value = '';
              if (mediaPreview) mediaPreview.innerHTML = '';
              if (mediaIds) mediaIds.value = '';
              if (input) input.dispatchEvent(new Event('input'));
              if (!inModal) composer.classList.remove('is-expanded');
              if (inModal) closeComposeModal();
              announce('Your Tweet was posted.');
            } else {
              // Nowhere on this page to show it, so go and look at it.
              window.location.href = payload.tweet ? payload.tweet.permalink : window.location.href;
            }
          })
          .catch(function (err) {
            window.alert(err.message);
          })
          .then(function () { restore(); });
      });
    }
  });

  /* ----------------------------------------------------- compose modal --- */
  var composeModal = $('[data-compose-modal]');
  var modalOpener = null;

  function openComposeModal(trigger) {
    if (!composeModal) return false;
    modalOpener = trigger || null;
    composeModal.hidden = false;
    composeModal.classList.add('is-open');
    body.classList.add('is-modal-open');
    var input = $('[data-compose-input]', composeModal);
    if (input) {
      // The textarea was measured while the dialog was hidden, so its
      // auto-grow height is stale until the counter runs again.
      input.dispatchEvent(new Event('input'));
      input.focus();
      input.selectionStart = input.value.length;
    }
    return true;
  }

  function closeComposeModal() {
    if (!composeModal || composeModal.hidden) return;
    composeModal.classList.remove('is-open');
    composeModal.hidden = true;
    body.classList.remove('is-modal-open');
    if (modalOpener && document.contains(modalOpener)) modalOpener.focus();
    modalOpener = null;
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest('[data-compose-open]');
    if (opener && composeModal) {
      // Without this handler the button is just a link to /compose.
      event.preventDefault();
      openComposeModal(opener);
      return;
    }
    if (!composeModal || composeModal.hidden) return;
    if (event.target.closest('[data-compose-modal-close]') || event.target === composeModal) {
      closeComposeModal();
    }
  });

  // Keep focus inside the dialog while it is open.
  document.addEventListener('keydown', function (event) {
    if (!composeModal || composeModal.hidden || event.key !== 'Tab') return;
    var focusable = $$('button, [href], input, textarea, select', composeModal)
      .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  /* ----------------------------------------------------- inline reply --- */
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action="reply"]');
    if (!button || button.tagName === 'A') return;
    var tweet = button.closest('.tweet');
    if (!tweet) return;
    event.preventDefault();
    tweet.classList.toggle('is-replying');
    var textarea = $('textarea', tweet);
    if (tweet.classList.contains('is-replying') && textarea) {
      var counter = $('[data-counter]', $('.tweet-inline-reply', tweet));
      wireCounter(textarea, counter, null, MAX_TWEET);
      textarea.focus();
      textarea.selectionStart = textarea.value.length;
    }
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.hasAttribute('data-inline-reply') || !window.fetch) return;
    event.preventDefault();
    var data = new FormData(form);
    var restore = busy($('button[type="submit"]', form));
    atLeast(post('/tweets', data))
      .then(function () {
        var tweet = form.closest('.tweet');
        tweet.classList.remove('is-replying');
        var counter = $('[data-count="replies"]', tweet);
        if (counter) counter.textContent = String((parseInt(counter.textContent, 10) || 0) + 1);
        form.reset();
        announce('Your reply was posted.');
      })
      .catch(function (err) { window.alert(err.message); })
      .then(function () { restore(); });
  });

  /* --------------------------------------- favorite / retweet toggles --- */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    var kind = form.getAttribute('data-interaction');
    if (!kind || !window.fetch) return;
    event.preventDefault();

    var button = $('button', form);
    // Retweet lives inside a dropdown, so the icon, the count and the active
    // state are on the toggle outside this form rather than on the button.
    var menu = form.closest('.menu-retweet');
    var indicator = menu ? $('[data-menu-toggle]', menu) : button;
    var countNode = $('[data-count]', menu || form);
    var restore = busy(button);
    atLeast(post(form.action, new FormData(form)), 220)
      .then(function (payload) {
        var active = kind === 'favorite' ? payload.favorited : payload.retweeted;
        indicator.classList.toggle('is-active', Boolean(active));
        button.setAttribute('aria-pressed', String(Boolean(active)));
        var id = form.action.match(/\/tweets\/(\d+)\//)[1];
        var verb = kind === 'favorite'
          ? (active ? 'unfavorite' : 'favorite')
          : (active ? 'unretweet' : 'retweet');
        form.action = '/tweets/' + id + '/' + verb;
        if (countNode) countNode.textContent = payload.count > 0 ? String(payload.count) : '';
        if (menu) {
          button.textContent = active ? 'Undo Retweet' : 'Retweet';
          closeMenus();
        } else if (button.lastChild && button.lastChild.nodeType === 3) {
          var label = kind === 'favorite'
            ? (active ? 'Favorited' : 'Favorite')
            : (active ? 'Retweeted' : 'Retweet');
          if (button.lastChild.textContent.trim()) button.lastChild.textContent = ' ' + label;
        }
        announce(kind + (active ? ' added' : ' removed'));
      })
      .catch(function (err) { window.alert(err.message); })
      .then(function () { restore(); });
  });

  /* ------------------------------------------------------ follow forms --- */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.hasAttribute('data-follow-form') || !window.fetch) return;
    event.preventDefault();
    var button = $('[data-follow-button]', form);
    var username = button.getAttribute('data-username');
    var isFollowing = button.classList.contains('is-following');
    var url = '/api/users/' + encodeURIComponent(username) + (isFollowing ? '/unfollow' : '/follow');

    var restore = busy(button);
    atLeast(post(url), 240)
      .then(function (payload) {
        if (payload.state === 'requested') {
          button.classList.add('is-pending');
          button.classList.remove('is-following');
          $('.label-follow', button).textContent = 'Pending';
          announce('Follow request sent to @' + username + '.');
        } else {
          var nowFollowing = payload.state === 'following';
          button.classList.toggle('is-following', nowFollowing);
          button.setAttribute('aria-pressed', String(nowFollowing));
          form.action = '/' + username + (nowFollowing ? '/unfollow' : '/follow');
          announce(nowFollowing ? 'Following @' + username : 'Unfollowed @' + username);
        }
      })
      .catch(function (err) { window.alert(err.message); })
      .then(function () { restore(); });
  });

  /* --------------------------------------------------------- load more --- */
  document.addEventListener('click', function (event) {
    var link = event.target.closest('[data-load-more]');
    if (!link || !window.fetch) return;
    event.preventDefault();
    var url = link.getAttribute('data-url');
    var cursor = link.getAttribute('data-cursor');
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    var footer = link.closest('[data-stream-footer]');
    footer.innerHTML = '<span class="loading-row"><span class="spinner"></span> Loading more Tweets</span>';
    atLeast(getHtml(url + separator + 'cursor=' + encodeURIComponent(cursor) + '&partial=1'))
      .then(function (html) {
        var stream = footer.parentNode;
        footer.remove();
        stream.insertAdjacentHTML('beforeend', html);
      })
      .catch(function () { window.location.href = link.href; });
  });

  /* --------------------------------------------- who to follow refresh --- */
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-wtf-refresh]');
    if (!button || !window.fetch) return;
    var page = (parseInt(button.getAttribute('data-page'), 10) || 0) + 1;
    button.setAttribute('data-page', String(page));
    var list = $('[data-wtf-list]');
    var undim = dim(list);
    var unbusy = busy(button);
    atLeast(getHtml('/who-to-follow?page=' + page))
      .then(function (html) { list.innerHTML = html; })
      .catch(function () { /* leave the current suggestions in place */ })
      .then(function () { undim(); unbusy(); });
  });

  /* ------------------------------------------------------ trend scope --- */
  var scopeToggle = $('[data-trend-scope-toggle]');
  if (scopeToggle) {
    scopeToggle.addEventListener('click', function () {
      $('[data-trend-scope-form]').classList.toggle('is-open');
    });
  }
  var scopeSelect = $('[data-trend-scope-select]');
  if (scopeSelect) {
    scopeSelect.addEventListener('change', function () {
      var parts = scopeSelect.value.split('|');
      $('[data-trend-scope-type]').value = parts[0];
      $('[data-trend-scope-name]').value = parts[1];
    });
  }

  /* -------------------------------------------------------- typeahead --- */
  var searchForm = $('[data-typeahead]');
  if (searchForm && window.fetch && body.getAttribute('data-user')) {
    var searchInput = $('input[type="search"]', searchForm);
    var results = $('[data-typeahead-results]', searchForm);
    var timer = null;

    searchInput.addEventListener('input', function () {
      window.clearTimeout(timer);
      var term = searchInput.value.trim();
      if (term.length < 2) { results.classList.remove('is-open'); return; }
      timer = window.setTimeout(function () {
        searchForm.classList.add('is-querying');
        getJson('/api/typeahead?q=' + encodeURIComponent(term))
          .then(function (payload) {
            results.innerHTML = '';
            if (!payload.users.length) { results.classList.remove('is-open'); return; }
            payload.users.forEach(function (user) {
              var link = document.createElement('a');
              link.href = '/' + user.username;
              link.setAttribute('role', 'option');
              var img = document.createElement('img');
              img.src = user.avatarUrl;
              img.alt = '';
              var name = document.createElement('span');
              name.className = 'name';
              name.textContent = user.displayName;
              var handle = document.createElement('span');
              handle.className = 'handle';
              handle.textContent = '@' + user.username;
              link.appendChild(img);
              link.appendChild(name);
              link.appendChild(handle);
              results.appendChild(link);
            });
            results.classList.add('is-open');
          })
          .catch(function () { results.classList.remove('is-open'); })
          .then(function () { searchForm.classList.remove('is-querying'); });
      }, 180);
    });

    document.addEventListener('click', function (event) {
      if (!searchForm.contains(event.target)) results.classList.remove('is-open');
    });
  }

  /* --------------------------------------------------------- lightbox --- */
  var lightbox = $('#lightbox');

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('is-open');
    lightbox.hidden = true;
    $('.lightbox-stage', lightbox).innerHTML = '';
  }

  if (lightbox) {
    document.addEventListener('click', function (event) {
      var trigger = event.target.closest('[data-lightbox]');
      if (trigger) {
        event.preventDefault();
        var stage = $('.lightbox-stage', lightbox);
        stage.innerHTML = '';
        var image = document.createElement('img');
        image.src = trigger.getAttribute('data-lightbox');
        image.alt = '';
        stage.appendChild(image);
        lightbox.hidden = false;
        lightbox.classList.add('is-open');
        return;
      }
      if (event.target.closest('[data-lightbox-close]') || event.target === lightbox) closeLightbox();
    });
  }

  /* ------------------------------------------------------ new Tweet bar --- */
  var newBar = $('[data-new-tweets]');
  if (newBar && window.fetch) {
    var sinceId = newBar.getAttribute('data-since') || '0';
    var pending = 0;

    function checkNew() {
      getJson('/home/new-count?since_id=' + encodeURIComponent(sinceId))
        .then(function (payload) {
          pending = payload.count || 0;
          if (pending > 0) {
            newBar.textContent = pending === 1 ? '1 new Tweet' : pending + ' new Tweets';
            newBar.hidden = false;
            newBar.classList.add('is-visible');
          }
        })
        .catch(function () { /* the timeline is still perfectly readable */ });
    }

    newBar.addEventListener('click', function () { window.location.reload(); });
    window.setInterval(checkNew, 45000);
    window.setTimeout(checkNew, 8000);
  }

  /* -------------------------------------------------- direct messages --- */
  var dmMessages = $('[data-dm-messages]');
  if (dmMessages) {
    dmMessages.scrollTop = dmMessages.scrollHeight;

    var dmForm = $('[data-dm-form]');
    var dmInput = $('[data-dm-input]');
    var dmCounter = $('[data-dm-counter]');
    if (dmInput && dmCounter) {
      dmInput.addEventListener('input', function () {
        dmCounter.textContent = String(1000 - dmInput.value.length);
      });
    }

    function appendMessage(message) {
      var wrapper = document.createElement('div');
      wrapper.className = 'dm-message' + (message.isOwn ? ' is-own' : '');
      wrapper.setAttribute('data-message-id', message.id);
      var avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.src = message.sender.avatarUrl;
      avatar.alt = '';
      var bubble = document.createElement('div');
      bubble.className = 'dm-bubble';
      bubble.textContent = message.body;
      var time = document.createElement('span');
      time.className = 'dm-time';
      time.textContent = message.timeShort;
      bubble.appendChild(time);
      wrapper.appendChild(avatar);
      wrapper.appendChild(bubble);
      dmMessages.appendChild(wrapper);
      dmMessages.scrollTop = dmMessages.scrollHeight;
      dmMessages.setAttribute('data-last-id', String(message.id));
    }

    if (dmForm && window.fetch) {
      dmForm.addEventListener('submit', function (event) {
        var file = $('input[type="file"]', dmForm);
        if (file && file.files && file.files.length > 0) return; // let the browser post it
        event.preventDefault();
        var data = new FormData(dmForm);
        var restore = busy($('button[type="submit"]', dmForm));
        atLeast(post(dmForm.action, data), 240)
          .then(function (payload) {
            if (payload.message) appendMessage(payload.message);
            dmInput.value = '';
            if (dmCounter) dmCounter.textContent = '1000';
          })
          .catch(function (err) { window.alert(err.message); })
          .then(function () { restore(); });
      });
    }

    window.setInterval(function () {
      var conversationId = dmMessages.getAttribute('data-conversation');
      var lastId = dmMessages.getAttribute('data-last-id') || '0';
      getJson('/messages/' + conversationId + '/poll?since_id=' + lastId)
        .then(function (payload) {
          (payload.messages || []).forEach(function (message) {
            if (!$('[data-message-id="' + message.id + '"]', dmMessages)) appendMessage(message);
          });
        })
        .catch(function () { /* polling is best effort */ });
    }, 20000);
  }

  /* ---------------------------------------------------- colour pickers --- */
  $$('[data-color-sync]').forEach(function (picker) {
    var target = document.getElementById(picker.getAttribute('data-color-sync'));
    if (!target) return;
    picker.addEventListener('input', function () { target.value = picker.value; });
    target.addEventListener('input', function () {
      if (/^#[0-9a-fA-F]{6}$/.test(target.value)) picker.value = target.value;
    });
  });

  /* ------------------------------------------------ new message toggle --- */
  var dmNewToggle = $('[data-dm-new-toggle]');
  if (dmNewToggle) {
    dmNewToggle.addEventListener('click', function () {
      var form = $('[data-dm-new-form]');
      form.hidden = !form.hidden;
      if (!form.hidden) $('input[name="username"]', form).focus();
    });
  }

  /* -------------------------------------------------------- websocket --- */
  if (body.getAttribute('data-ws') === '1' && 'WebSocket' in window && body.getAttribute('data-user')) {
    (function connect(attempt) {
      var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var socket;
      try {
        socket = new WebSocket(protocol + '//' + window.location.host + '/ws');
      } catch (err) {
        return; // the site works perfectly well without live updates
      }
      socket.addEventListener('message', function (event) {
        var payload;
        try { payload = JSON.parse(event.data); } catch (err) { return; }
        if (payload.type === 'notification' || payload.type === 'message') refreshBadges();
      });
      socket.addEventListener('close', function () {
        if (attempt > 5) return;
        window.setTimeout(function () { connect(attempt + 1); }, Math.min(30000, 2000 * Math.pow(2, attempt)));
      });
    })(0);
  }

  function refreshBadges() {
    getJson('/api/badges')
      .then(function (payload) {
        var notifications = $('[data-badge="notifications"]');
        if (notifications) {
          notifications.textContent = payload.notifications > 99 ? '99+' : String(payload.notifications);
          notifications.hidden = payload.notifications === 0;
        }
        var messages = $('[data-badge="messages"]');
        if (messages) messages.hidden = payload.messages === 0;
      })
      .catch(function () { /* badges are cosmetic */ });
  }
}());
