// Tema claro/escuro compartilhado pelo site e pelo sistema.
// Script comum (não módulo) carregado no <head> para aplicar o tema antes de pintar a tela.
(function () {
  var CHAVE = "lis-tema";
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function ler() { try { return localStorage.getItem(CHAVE) || "sistema"; } catch (e) { return "sistema"; } }
  function resolver(pref) { return pref === "sistema" ? (mq && mq.matches ? "escuro" : "claro") : pref; }
  function aplicar(pref, animar) {
    var html = document.documentElement;
    if (animar) { html.classList.add("trocando-tema"); setTimeout(function () { html.classList.remove("trocando-tema"); }, 350); }
    var t = resolver(pref);
    html.setAttribute("data-tema", t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "escuro" ? "#0C1211" : "#136F63");
    try { window.dispatchEvent(new CustomEvent("tema", { detail: t })); } catch (e) { /* navegador antigo */ }
  }
  window.lisTema = {
    preferencia: ler,
    atual: function () { return document.documentElement.getAttribute("data-tema") || "claro"; },
    definir: function (pref) { try { localStorage.setItem(CHAVE, pref); } catch (e) { /* sem armazenamento */ } aplicar(pref, true); },
    alternar: function () { this.definir(this.atual() === "escuro" ? "claro" : "escuro"); },
  };
  if (mq && mq.addEventListener) mq.addEventListener("change", function () { if (ler() === "sistema") aplicar("sistema", true); });
  aplicar(ler(), false);
})();
