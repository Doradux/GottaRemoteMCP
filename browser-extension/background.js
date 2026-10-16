async function tryAutoDiscoverLocal() {
  try {
    const r = await fetch("http://localhost:3000/local-session?_t=" + Date.now(), {
      headers: { Accept: "application/json" },
    });
    if (r.ok) {
      const data = await r.json();
      if (data && data.endpoint) return data;
    }
  } catch {
    // No local server on 3000
  }
  return null;
}

function buildActionRequest(endpoint, payload) {
  const act = payload.action || "exec";
  const t = Date.now();
  let url = `${endpoint}?format=json&_t=${t}`;
  let options = {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };

  if (act === "exec") {
    url = `${endpoint}/exec?format=json&_t=${t}`;
    options.method = "POST";
    options.body = JSON.stringify({
      command: payload.cmd || payload.command,
      cwd: payload.cwd,
      timeout: payload.timeout,
    });
  } else if (act === "read") {
    const p = encodeURIComponent(payload.path || "");
    const s = payload.start ? `&start=${payload.start}` : "";
    const e = payload.end ? `&end=${payload.end}` : "";
    url = `${endpoint}/read?format=json&path=${p}${s}${e}&_t=${t}`;
  } else if (act === "write") {
    url = `${endpoint}/write?format=json&_t=${t}`;
    options.method = "POST";
    options.body = JSON.stringify({
      path: payload.path,
      content: payload.content,
      append: payload.append,
    });
  } else if (act === "edit") {
    url = `${endpoint}/edit?format=json&_t=${t}`;
    options.method = "POST";
    options.body = JSON.stringify({
      path: payload.path,
      search: payload.search,
      replace: payload.replace,
    });
  } else if (act === "ls") {
    url = `${endpoint}/ls?format=json&path=${encodeURIComponent(payload.path || ".")}&_t=${t}`;
  } else if (act === "search") {
    url = `${endpoint}/search?format=json&q=${encodeURIComponent(payload.q || "")}&path=${encodeURIComponent(payload.path || ".")}&_t=${t}`;
  } else if (act === "sessions") {
    url = `${endpoint}/sessions?format=json&_t=${t}`;
  } else if (act === "session-output") {
    url = `${endpoint}/session-output?format=json&pid=${encodeURIComponent(payload.pid)}&_t=${t}`;
  } else if (act === "kill") {
    url = `${endpoint}/kill?format=json&pid=${encodeURIComponent(payload.pid)}&_t=${t}`;
  } else if (act === "input") {
    const q = new URLSearchParams({
      ...payload,
      action: payload.type || payload.action || "click",
      format: "json",
      _t: String(t),
    }).toString();
    url = `${endpoint}/input?${q}`;
  }

  return { url, options };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GOTTA_PING") {
    (async () => {
      let ep = (msg.endpoint || "").trim().replace(/\?.*$/, "").replace(/\/+$/, "");

      if (!ep || ep === "http://localhost:3000") {
        const local = await tryAutoDiscoverLocal();
        if (local) {
          chrome.storage.local.set({ gottaEndpoint: local.endpoint });
          return sendResponse({
            ok: true,
            endpoint: local.endpoint,
            data: { status: local.status },
          });
        }
      }

      if (!ep) {
        return sendResponse({
          ok: false,
          error: "Pega la URL /c/user/pass generada en bash",
        });
      }

      try {
        let r = await fetch(`${ep}?format=json&_t=${Date.now()}`, {
          headers: { Accept: "application/json" },
        });
        if (r.status === 401 && ep.includes("localhost")) {
          const local = await tryAutoDiscoverLocal();
          if (local) {
            ep = local.endpoint;
            chrome.storage.local.set({ gottaEndpoint: ep });
            r = await fetch(`${ep}?format=json&_t=${Date.now()}`, {
              headers: { Accept: "application/json" },
            });
          }
        }
        if (!r.ok) {
          return sendResponse({
            ok: false,
            error: `HTTP ${r.status}: Credenciales caducadas o URL incorrecta`,
          });
        }
        const data = await r.json();
        sendResponse({ ok: true, endpoint: ep, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === "GOTTA_EXEC") {
    (async () => {
      let ep = (msg.endpoint || "").trim().replace(/\?.*$/, "").replace(/\/+$/, "");
      try {
        let reqData = buildActionRequest(ep, msg.payload);
        let r = await fetch(reqData.url, reqData.options);

        if (r.status === 401 && ep.includes("localhost")) {
          const local = await tryAutoDiscoverLocal();
          if (local) {
            ep = local.endpoint;
            chrome.storage.local.set({ gottaEndpoint: ep });
            reqData = buildActionRequest(ep, msg.payload);
            r = await fetch(reqData.url, reqData.options);
          }
        }

        const data = await r.json();
        sendResponse({ ok: true, endpoint: ep, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});
