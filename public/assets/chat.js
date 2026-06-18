/* Assistant Artéo — widget de chat en pop-up, injecté sur toutes les pages.
   Interroge /api/assistant (base de connaissances). Aucune dépendance externe. */
(function () {
  if (window.__arteoChat) return;
  window.__arteoChat = true;

  var BRAND = "#4f46e5", BRAND2 = "#6366f1";

  var css = ''
    + '.arteo-chat-btn{position:fixed;right:22px;bottom:22px;width:60px;height:60px;border:none;border-radius:50%;'
    + 'background:linear-gradient(135deg,' + BRAND + ',' + BRAND2 + ');color:#fff;font-size:26px;cursor:pointer;'
    + 'box-shadow:0 10px 28px rgba(79,70,229,.42);z-index:2147483000;transition:transform .15s ease;display:flex;align-items:center;justify-content:center}'
    + '.arteo-chat-btn:hover{transform:scale(1.07)}'
    + '.arteo-chat-panel{position:fixed;right:22px;bottom:94px;width:370px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 130px);'
    + 'background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(15,23,42,.28);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;'
    + 'font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border:1px solid #e5e7eb}'
    + '.arteo-chat-panel.open{display:flex;animation:arteoUp .18s ease}'
    + '@keyframes arteoUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}'
    + '.arteo-ch-head{background:linear-gradient(135deg,' + BRAND + ',' + BRAND2 + ');color:#fff;padding:15px 16px;display:flex;align-items:center;gap:10px}'
    + '.arteo-ch-head .av{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-size:18px}'
    + '.arteo-ch-head .t{font-weight:700;font-size:15px;line-height:1.1}'
    + '.arteo-ch-head .s{font-size:11.5px;opacity:.85}'
    + '.arteo-ch-head .x{margin-left:auto;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;opacity:.85;line-height:1}'
    + '.arteo-ch-body{flex:1;overflow-y:auto;padding:16px;background:#f8fafc;display:flex;flex-direction:column;gap:10px}'
    + '.arteo-msg{max-width:84%;padding:10px 13px;border-radius:14px;font-size:13.5px;line-height:1.5;word-wrap:break-word}'
    + '.arteo-msg.bot{background:#fff;border:1px solid #e5e7eb;color:#1e293b;border-bottom-left-radius:4px;align-self:flex-start}'
    + '.arteo-msg.user{background:' + BRAND + ';color:#fff;border-bottom-right-radius:4px;align-self:flex-end}'
    + '.arteo-msg b{font-weight:700}.arteo-msg.bot a{color:' + BRAND + '}'
    + '.arteo-sug{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 6px}'
    + '.arteo-sug button{background:#eef2ff;border:1px solid #c7d2fe;color:' + BRAND + ';font-size:12.5px;padding:7px 11px;border-radius:999px;cursor:pointer;font-family:inherit}'
    + '.arteo-sug button:hover{background:#e0e7ff}'
    + '.arteo-ch-foot{display:flex;gap:8px;padding:11px;border-top:1px solid #eef0f4;background:#fff}'
    + '.arteo-ch-foot input{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font-size:13.5px;font-family:inherit;outline:none}'
    + '.arteo-ch-foot input:focus{border-color:' + BRAND + '}'
    + '.arteo-ch-foot button{background:' + BRAND + ';border:none;color:#fff;width:42px;border-radius:10px;font-size:17px;cursor:pointer}'
    + '.arteo-typing{font-size:12px;color:#94a3b8;padding:2px 4px}';

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var btn = document.createElement("button");
  btn.className = "arteo-chat-btn";
  btn.setAttribute("aria-label", "Assistant Artéo");
  btn.innerHTML = "💬";

  var panel = document.createElement("div");
  panel.className = "arteo-chat-panel";
  panel.innerHTML =
    '<div class="arteo-ch-head">'
    + '<div class="av">A</div>'
    + '<div><div class="t">Assistant Artéo</div><div class="s">En ligne · réponses immédiates</div></div>'
    + '<button class="x" aria-label="Fermer">×</button>'
    + '</div>'
    + '<div class="arteo-ch-body" id="arteoBody"></div>'
    + '<div class="arteo-sug" id="arteoSug"></div>'
    + '<form class="arteo-ch-foot" id="arteoForm">'
    + '<input id="arteoInput" autocomplete="off" placeholder="Écrivez votre question…" />'
    + '<button type="submit" aria-label="Envoyer">➤</button>'
    + '</form>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var body = panel.querySelector("#arteoBody");
  var sug = panel.querySelector("#arteoSug");
  var form = panel.querySelector("#arteoForm");
  var input = panel.querySelector("#arteoInput");
  var greeted = false;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function addMsg(role, html) {
    var d = document.createElement("div");
    d.className = "arteo-msg " + role;
    d.innerHTML = html;
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
    return d;
  }
  function renderSug(list) {
    sug.innerHTML = "";
    (list || []).forEach(function (q) {
      var b = document.createElement("button");
      b.textContent = q;
      b.onclick = function () { ask(q); };
      sug.appendChild(b);
    });
  }
  function ask(q) {
    q = (q || "").trim();
    if (!q) return;
    addMsg("user", escapeHtml(q));
    sug.innerHTML = "";
    input.value = "";
    var typing = addMsg("bot", '<span class="arteo-typing">…</span>');
    fetch("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        typing.innerHTML = d.answer || "Désolé, je n'ai pas compris.";
        body.scrollTop = body.scrollHeight;
        renderSug(d.suggestions);
      })
      .catch(function () {
        typing.innerHTML = "Connexion impossible pour le moment. Réessayez dans un instant.";
      });
  }
  function greet() {
    if (greeted) return;
    greeted = true;
    addMsg("bot", "Bonjour 👋 Je suis l'assistant <b>Artéo</b>. Comment puis-je vous aider ?");
    renderSug(["Quels sont les tarifs ?", "Comment créer une facture ?", "Comment connecter Google ?", "C'est quoi Artéo ?"]);
  }
  function toggle(open) {
    var willOpen = open === undefined ? !panel.classList.contains("open") : open;
    panel.classList.toggle("open", willOpen);
    btn.innerHTML = willOpen ? "×" : "💬";
    if (willOpen) { greet(); setTimeout(function () { input.focus(); }, 50); }
  }

  btn.onclick = function () { toggle(); };
  panel.querySelector(".x").onclick = function () { toggle(false); };
  form.onsubmit = function (e) { e.preventDefault(); ask(input.value); };
})();
