chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GOTTA_EXEC") {
    const { endpoint, payload } = msg;
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

    fetch(url, options)
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }
});
