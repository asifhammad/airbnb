(function () {
  const state = {
    enabled: false,
    ready: false,
    posthog: null,
    queue: [],
  };

  function runOrQueue(action) {
    if (state.ready && state.posthog) {
      try { action(); } catch (_) { /* no-op */ }
      return;
    }
    state.queue.push(action);
  }

  function flushQueue() {
    if (!state.ready || !state.posthog) return;
    const pending = state.queue.splice(0);
    pending.forEach((fn) => {
      try { fn(); } catch (_) { /* no-op */ }
    });
  }

  function loadScript(host, onLoad) {
    const s = document.createElement('script');
    s.async = true;
    s.src = `${host.replace(/\/$/, '')}/static/array.js`;
    s.onload = onLoad;
    s.onerror = function () { /* optional */ };
    document.head.appendChild(s);
  }

  function init(config) {
    if (!config || !config.enabled || !config.key || !config.host) return;
    state.enabled = true;
    loadScript(config.host, function () {
      if (!window.posthog) return;
      state.posthog = window.posthog;
      state.posthog.init(config.key, {
        api_host: config.host,
        person_profiles: 'identified_only',
        capture_pageview: true,
        autocapture: false,
      });
      state.ready = true;
      flushQueue();
    });
  }

  window.analytics = {
    isEnabled: function () {
      return state.enabled;
    },
    track: function (event, props) {
      if (!state.enabled || !event) return;
      runOrQueue(function () {
        state.posthog.capture(String(event), props || {});
      });
    },
    identify: function (distinctId, props) {
      if (!state.enabled || !distinctId) return;
      runOrQueue(function () {
        state.posthog.identify(String(distinctId), props || {});
      });
    },
    reset: function () {
      if (!state.enabled) return;
      runOrQueue(function () {
        state.posthog.reset();
      });
    },
  };

  fetch('/api/public-config', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((cfg) => init(cfg?.posthog))
    .catch(() => { /* optional */ });
})();
