// Estilos do painel de diagnóstico. Usam os tokens do sistema (app.css) quando
// existem — inclusive o tema escuro — e têm valores próprios para funcionar
// mesmo quando o app.css não carregou (falha na inicialização).
export const CSS = `
.diag-raiz{
  --dg-bg:var(--bg,#F2F4F3);--dg-sf:var(--surface,#fff);--dg-ink:var(--ink,#18211F);--dg-mut:var(--muted,#5E6B67);
  --dg-ln:var(--line,#DDE3E0);--dg-ln2:var(--line-strong,#C5CFCB);--dg-pri:var(--primary,#136F63);--dg-on:var(--on-primary,#fff);
  --dg-ok:var(--ok,#1B7F3B);--dg-oks:var(--ok-soft,#E6F4EA);--dg-av:#C77700;--dg-avs:var(--amber-soft,#FFF4DC);--dg-avi:var(--warn-ink,#8A5300);
  --dg-er:var(--danger,#B42318);--dg-ers:var(--danger-soft,#FDECEA);--dg-r:var(--r-md,12px);
  font-family:var(--font,"Onest",system-ui,-apple-system,"Segoe UI",sans-serif);color:var(--dg-ink);font-size:15px;line-height:1.45;
}
html[data-tema="escuro"] .diag-raiz{--dg-av:#F2B33D;--dg-oks:#11291A;--dg-ers:#331512}
.diag-raiz *{box-sizing:border-box}
.diag-raiz.dg-sobre{position:fixed;inset:0;z-index:9999;background:rgba(10,16,15,.55);display:flex;justify-content:center;align-items:stretch;padding:2vh 2vw;backdrop-filter:blur(2px)}
.diag-raiz.dg-embutido{position:relative}
.dg-janela{position:relative;background:var(--dg-bg);width:min(1180px,100%);border-radius:18px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.3)}
.dg-embutido .dg-janela{box-shadow:none;border-radius:0;background:transparent;width:100%}
.dg-ic{flex:none;vertical-align:-3px}
.dg-topo{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 18px;background:var(--dg-sf);border-bottom:1px solid var(--dg-ln)}
.dg-embutido .dg-topo{border-radius:var(--dg-r);border:1px solid var(--dg-ln);margin-bottom:12px}
.dg-titulo{display:flex;align-items:center;gap:10px;flex:1;min-width:200px}
.dg-logo{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--dg-pri);color:var(--dg-on)}
.dg-titulo h1{font-size:1.2rem;margin:0;line-height:1.2}
.dg-sub{margin:0;color:var(--dg-mut);font-size:.82rem}
.dg-acoes-topo{display:flex;gap:6px;flex-wrap:wrap}
.dg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:0 12px;border-radius:10px;border:1px solid var(--dg-ln2);background:var(--dg-sf);color:var(--dg-ink);font:600 .86rem/1 inherit;font-family:inherit;cursor:pointer;white-space:nowrap}
.dg-btn:hover{border-color:var(--dg-pri)}
.dg-btn:focus-visible,.dg-check:focus-visible,.dg-prob:focus-visible,.dg-t-cart:focus-visible{outline:3px solid color-mix(in srgb,var(--dg-pri) 45%,transparent);outline-offset:2px}
.dg-btn.dg-pri{background:var(--dg-pri);border-color:var(--dg-pri);color:var(--dg-on)}
.dg-btn.dg-icone{width:38px;padding:0}
.dg-btn.dg-peq{min-height:32px;font-size:.8rem}
.dg-btn.dg-grande{min-height:46px;padding:0 18px;font-size:.95rem}
.dg-btn:disabled{opacity:.6;cursor:wait}
.dg-faixa{display:flex;gap:10px;align-items:flex-start;padding:10px 18px;font-size:.9rem}
.dg-faixa.erro{background:var(--dg-ers);color:var(--dg-er)}.dg-faixa.aviso{background:var(--dg-avs);color:var(--dg-avi)}
.dg-faixa strong{color:inherit}
.dg-corpo{flex:1;overflow:auto;padding:16px 18px 28px}
.dg-embutido .dg-corpo{padding:12px 0 24px;overflow:visible}

/* Herói / semáforo */
.dg-heroi{display:flex;align-items:center;gap:18px;margin:14px 18px 0;padding:16px 18px;border-radius:16px;background:var(--dg-sf);border:1px solid var(--dg-ln);border-left:6px solid var(--dg-ok)}
.dg-embutido .dg-heroi{margin:0 0 4px}
.dg-heroi.aviso{border-left-color:var(--dg-av)}.dg-heroi.erro{border-left-color:var(--dg-er);background:linear-gradient(90deg,var(--dg-ers),var(--dg-sf) 60%)}
.dg-heroi.rodando{border-left-color:var(--dg-ln2)}
.dg-semaforo{display:flex;flex-direction:column;gap:5px;padding:7px;border-radius:14px;background:#1d2422;flex:none}
.dg-semaforo span{width:20px;height:20px;border-radius:50%;background:#3a4441;transition:.3s}
.dg-heroi.erro .r{background:#F04438;box-shadow:0 0 14px #F04438}
.dg-heroi.aviso .a{background:#FDB022;box-shadow:0 0 14px #FDB022}
.dg-heroi.ok .v{background:#32D583;box-shadow:0 0 14px #32D583}
.dg-heroi.rodando .a{animation:dg-pisca 1s infinite}
@keyframes dg-pisca{50%{background:#FDB022}}
.dg-heroi-txt{flex:1;min-width:0}
.dg-heroi-rot{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--dg-mut)}
.dg-heroi h2{margin:2px 0 2px;font-size:1.35rem;line-height:1.2}
.dg-heroi p{margin:0;color:var(--dg-mut);font-size:.9rem}
.dg-placar{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.dg-placar span{font-size:.75rem;font-weight:700;padding:3px 8px;border-radius:999px}
.dg-placar .ok{background:var(--dg-oks);color:var(--dg-ok)}.dg-placar .aviso{background:var(--dg-avs);color:var(--dg-avi)}.dg-placar .erro{background:var(--dg-ers);color:var(--dg-er)}

/* Abas */
.dg-abas{display:flex;gap:4px;padding:12px 18px 0;overflow-x:auto;border-bottom:1px solid var(--dg-ln)}
.dg-embutido .dg-abas{padding:12px 0 0}
.dg-abas button{border:0;background:none;padding:10px 12px;font:600 .88rem inherit;font-family:inherit;color:var(--dg-mut);border-bottom:3px solid transparent;cursor:pointer;white-space:nowrap}
.dg-abas button[aria-selected="true"]{color:var(--dg-ink);border-bottom-color:var(--dg-pri)}
.dg-cont{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--dg-er);color:#fff;font-size:.7rem}
.dg-cont:empty{display:none}
.dg-intro{margin:0 0 14px;color:var(--dg-mut);font-size:.9rem;max-width:80ch}

/* Check-up */
.dg-grade{columns:3 300px;column-gap:14px}
.dg-grupo h3{margin:0 0 6px;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dg-mut)}
.dg-grupo{display:flex;flex-direction:column;gap:8px;break-inside:avoid;margin-bottom:16px}
.dg-check{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;padding:11px 12px;border-radius:12px;border:1px solid var(--dg-ln);background:var(--dg-sf);color:inherit;font:inherit;cursor:default}
.dg-check.clicavel{cursor:pointer}.dg-check.clicavel:hover{border-color:var(--dg-ln2)}
.dg-check.erro{border-color:color-mix(in srgb,var(--dg-er) 45%,var(--dg-ln));background:color-mix(in srgb,var(--dg-ers) 60%,var(--dg-sf))}
.dg-check.aviso{border-color:color-mix(in srgb,var(--dg-av) 45%,var(--dg-ln))}
.dg-luz{width:12px;height:12px;border-radius:50%;margin-top:4px;flex:none;background:var(--dg-ln2)}
.ok>.dg-luz,.dg-luz.ok{background:var(--dg-ok)}.aviso>.dg-luz,.dg-luz.aviso{background:var(--dg-av)}.erro>.dg-luz,.dg-luz.erro{background:var(--dg-er);box-shadow:0 0 0 4px color-mix(in srgb,var(--dg-er) 20%,transparent)}
.dg-luz.info,.info>.dg-luz{background:var(--dg-ln2)}
.rodando>.dg-luz{background:none;border:2px solid var(--dg-ln2);border-top-color:var(--dg-pri);animation:dg-gira .8s linear infinite}
.dg-check-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dg-check-tit{font-size:.8rem;color:var(--dg-mut);font-weight:600}
.dg-check-val{font-weight:700;font-size:.98rem}
.erro .dg-check-val{color:var(--dg-er)}.aviso .dg-check-val{color:var(--dg-avi)}
.dg-check-det{font-size:.8rem;color:var(--dg-mut);white-space:pre-line;overflow-wrap:anywhere}
.dg-check-ir{align-self:center;display:flex;align-items:center;gap:2px;font-size:.78rem;font-weight:700;color:var(--dg-er);white-space:nowrap}
.aviso .dg-check-ir{color:var(--dg-avi)}
.dg-barra{display:block;height:6px;border-radius:9px;background:var(--dg-ln);margin-top:5px;overflow:hidden}
.dg-barra span{display:block;height:100%;background:var(--dg-pri)}
.aviso .dg-barra span{background:var(--dg-av)}.erro .dg-barra span{background:var(--dg-er)}

/* Listas de problemas */
.dg-lista{display:flex;flex-direction:column;gap:8px}
.dg-prob{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:12px;border-radius:12px;border:1px solid var(--dg-ln);background:var(--dg-sf);color:inherit;font:inherit;cursor:pointer}
.dg-prob:hover{border-color:var(--dg-ln2)}
.dg-prob-ic{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;flex:none;color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent)}
.dg-prob-txt{flex:1;min-width:0;display:flex;flex-direction:column}
.dg-prob-tit{font-weight:700}
.dg-prob-sub{font-size:.8rem;color:var(--dg-mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-selo{font-size:.7rem;font-weight:800;padding:3px 8px;border-radius:999px;white-space:nowrap;text-transform:uppercase;letter-spacing:.03em}
.dg-selo.erro{background:var(--dg-ers);color:var(--dg-er)}.dg-selo.aviso{background:var(--dg-avs);color:var(--dg-avi)}.dg-selo.info{background:var(--dg-ln);color:var(--dg-mut)}
.dg-vezes{font-weight:800;font-size:.85rem;color:var(--dg-mut);font-variant-numeric:tabular-nums}
.dg-tag{font-size:.68rem;font-weight:700;padding:2px 6px;border-radius:6px;background:var(--dg-ln);color:var(--dg-mut)}

/* Linha do tempo */
.dg-filtros{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
.dg-chips{display:flex;gap:4px;flex-wrap:wrap}
.dg-chip{border:1px solid var(--dg-ln2);background:var(--dg-sf);color:var(--dg-ink);border-radius:999px;padding:6px 11px;font:600 .8rem inherit;font-family:inherit;cursor:pointer}
.dg-chip.on{background:var(--dg-ink);color:var(--dg-sf);border-color:var(--dg-ink)}
.dg-input{min-height:36px;border:1px solid var(--dg-ln2);border-radius:10px;padding:0 10px;background:var(--dg-sf);color:var(--dg-ink);font:inherit;font-size:.86rem}
.dg-input.dg-largo{width:100%;margin-bottom:14px}
.dg-chk{display:flex;align-items:center;gap:6px;font-size:.84rem;color:var(--dg-mut)}
.dg-tempo,.dg-filme{list-style:none;margin:0;padding:0;position:relative}
.dg-tempo::before,.dg-filme::before{content:"";position:absolute;left:78px;top:6px;bottom:6px;width:2px;background:var(--dg-ln)}
.dg-tempo li,.dg-filme li{display:flex;gap:12px;align-items:flex-start;position:relative;padding:4px 0}
.dg-t-hora{width:66px;flex:none;text-align:right;font-size:.75rem;color:var(--dg-mut);font-variant-numeric:tabular-nums;padding-top:3px}
.dg-t-pino{width:12px;height:12px;border-radius:50%;flex:none;margin-top:5px;background:var(--dg-ln2);border:2px solid var(--dg-bg);position:relative;z-index:1}
.dg-t-ev.erro .dg-t-pino,.dg-filme .erro .dg-t-pino{background:var(--dg-er)}.dg-t-ev.aviso .dg-t-pino{background:var(--dg-av)}.dg-t-ev.info .dg-t-pino{background:var(--dg-mut)}
.dg-t-passo{font-size:.82rem;color:var(--dg-mut)}
.dg-t-passo .dg-t-pino{width:8px;height:8px;margin:7px 2px 0}
.dg-dia{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--dg-mut);padding:12px 0 4px 92px!important}
.dg-t-cart{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;text-align:left;padding:9px 12px;border-radius:10px;border:1px solid var(--dg-ln);background:var(--dg-sf);color:inherit;font:inherit;cursor:pointer}
.dg-t-cart:hover{border-color:var(--dg-ln2)}
.dg-t-tit{font-weight:700;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dg-t-msg{font-size:.84rem;overflow-wrap:anywhere}
.dg-t-meta{font-size:.74rem;color:var(--dg-mut)}
.dg-loja{background:var(--dg-sf);border:1px solid var(--dg-ln);border-radius:12px;padding:4px 12px;margin-bottom:10px}
.dg-loja summary{display:flex;align-items:center;gap:10px;padding:10px 0;cursor:pointer;flex-wrap:wrap}
.dg-loja-meta{font-size:.8rem;color:var(--dg-mut)}
.dg-loja .dg-lista{padding-bottom:12px}
.dg-loja .dg-luz{margin:0}
.dg-m-area h3{display:flex;align-items:center;gap:8px;margin:18px 0 8px;font-size:.95rem;color:var(--c)}
.dg-m-itens{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:6px}
.dg-m-item{display:flex;align-items:center;gap:8px;text-align:left;padding:10px;border:1px solid var(--dg-ln);border-radius:10px;background:var(--dg-sf);color:inherit;font:600 .86rem inherit;font-family:inherit;cursor:pointer}
.dg-m-item:hover{border-color:var(--dg-ln2)}
.dg-vazio{display:flex;flex-direction:column;align-items:center;gap:8px;padding:40px 16px;color:var(--dg-mut);text-align:center}
.dg-vazio.ok{color:var(--dg-ok)}.dg-vazio.aviso{color:var(--dg-avi)}
.dg-giro{display:inline-block;width:18px;height:18px;border-radius:50%;border:2px solid var(--dg-ln2);border-top-color:var(--dg-pri);animation:dg-gira .8s linear infinite}
@keyframes dg-gira{to{transform:rotate(360deg)}}

/* Cartão do problema */
.dg-cartao-fundo{position:fixed;inset:0;z-index:10000;background:rgba(10,16,15,.5);display:flex;justify-content:flex-end}
.dg-cartao{width:min(860px,100%);height:100%;background:var(--dg-bg);display:flex;flex-direction:column;box-shadow:-20px 0 50px rgba(0,0,0,.25);animation:dg-entra .22s ease-out;outline:none}
@keyframes dg-entra{from{transform:translateX(40px);opacity:0}}
.dg-c-topo{display:flex;gap:12px;align-items:flex-start;padding:16px 18px;background:var(--dg-sf);border-bottom:1px solid var(--dg-ln);border-top:5px solid var(--c)}
.dg-c-ic{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;flex:none;color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent)}
.dg-c-tit{flex:1;min-width:0}
.dg-c-tit h2{margin:4px 0 2px;font-size:1.35rem;line-height:1.2}
.dg-c-chips{display:flex;gap:6px;flex-wrap:wrap}
.dg-area{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:var(--c)}
.dg-c-quando{margin:0;font-size:.8rem;color:var(--dg-mut)}
.dg-c-corpo{flex:1;overflow:auto;padding:16px 18px 40px;display:flex;flex-direction:column;gap:14px}
.dg-msg{background:var(--dg-sf);border:1px dashed var(--dg-ln2);border-radius:12px;padding:10px 14px}
.dg-msg span{display:block;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--dg-mut)}
.dg-msg q{font-weight:600;overflow-wrap:anywhere}
.dg-sec{background:var(--dg-sf);border:1px solid var(--dg-ln);border-radius:14px;padding:14px 16px}
.dg-sec h3{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:1rem}
.dg-sec p{margin:0 0 6px}
.dg-sec-oque{border-left:5px solid var(--c)}
.dg-sec-oque>p:first-of-type{font-size:1.02rem}
.dg-impacto{background:var(--dg-avs);color:var(--dg-avi);padding:8px 10px;border-radius:10px;margin-top:8px!important;font-size:.9rem}
.dg-causas{margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:6px;counter-reset:c}
.dg-causas li{position:relative;padding:6px 10px 6px 34px;border-radius:8px;overflow:hidden;counter-increment:c;font-size:.92rem}
.dg-causas li::before{content:counter(c);position:absolute;left:8px;top:6px;width:18px;height:18px;border-radius:50%;background:var(--c);color:#fff;font-size:.7rem;font-weight:800;display:grid;place-items:center}
.dg-prob-barra{position:absolute;inset:0 auto 0 0;width:var(--p);background:color-mix(in srgb,var(--c) 9%,transparent);z-index:-1}
.dg-causas li{z-index:0}
.dg-nota{font-size:.78rem;color:var(--dg-mut);margin:6px 0 0!important}
.dg-duas{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.dg-passos ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;counter-reset:p}
.dg-passos li{counter-increment:p;border-radius:10px;padding:8px 10px;background:var(--dg-bg);transition:.2s}
.dg-passos label{display:flex;gap:10px;align-items:flex-start;cursor:pointer;font-size:.9rem}
.dg-passos label::before{content:counter(p);flex:none;width:24px;height:24px;border-radius:8px;display:grid;place-items:center;font-weight:800;font-size:.8rem;background:var(--dg-pri);color:var(--dg-on)}
.dg-passos.tec label::before{background:var(--dg-ink);color:var(--dg-sf)}
.dg-passos input{order:3;margin-left:auto;margin-top:4px;width:18px;height:18px;flex:none;accent-color:var(--dg-ok)}
.dg-passos li.feito{background:var(--dg-oks)}.dg-passos li.feito span{text-decoration:line-through;color:var(--dg-mut)}
.dg-passos code,.dg-sec code{font-family:ui-monospace,Consolas,monospace;font-size:.82em;background:var(--dg-bg);border:1px solid var(--dg-ln);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.dg-passos li code{background:var(--dg-sf)}
.dg-code,.dg-trecho{margin:0;background:#0F1715;color:#D7E3DF;border-radius:10px;padding:12px;font:12.5px/1.55 ui-monospace,Consolas,monospace;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px}
.dg-trecho{white-space:pre}
.dg-trecho span{display:block;padding:0 6px;border-radius:4px}
.dg-trecho b{display:inline-block;width:46px;color:#6B7F79;font-weight:400;user-select:none}
.dg-trecho .alvo{background:rgba(240,68,56,.25);outline:1px solid rgba(240,68,56,.6)}
.dg-arquivo{font-size:.9rem}
.dg-resolver{border-color:color-mix(in srgb,var(--dg-ok) 40%,var(--dg-ln))}
.dg-acoes{display:flex;gap:8px;flex-wrap:wrap}
.dg-filme li{font-size:.86rem}
.dg-filme .final{font-weight:600;color:var(--dg-er)}
.dg-filme::before{left:78px}
.dg-outras{margin:0;padding-left:18px;font-size:.84rem;display:flex;flex-direction:column;gap:3px}
.dg-outras em{font-weight:700;font-style:normal}
.dg-muted{color:var(--dg-mut)}
.dg-tec summary{cursor:pointer;font-weight:700;display:flex;align-items:center;gap:8px}
.dg-tec[open] summary{margin-bottom:10px}
.dg-tec .dg-btn{margin-top:8px}
.dg-avisos{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:10001;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}
.dg-aviso{background:var(--dg-ink);color:var(--dg-sf);padding:10px 16px;border-radius:10px;font-weight:600;font-size:.88rem;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.dg-aviso.ok{background:var(--dg-ok);color:#fff}.dg-aviso.erro{background:var(--dg-er);color:#fff}

@media (max-width:760px){
  .diag-raiz.dg-sobre{padding:0}
  .dg-janela{border-radius:0}
  .dg-acoes-topo .dg-btn span{display:none}
  .dg-acoes-topo .dg-btn{width:40px;padding:0}
  .dg-heroi{flex-wrap:wrap;margin:10px 10px 0;gap:12px}
  .dg-heroi .dg-btn{width:100%}
  .dg-semaforo{flex-direction:row}
  .dg-abas{padding:8px 10px 0}
  .dg-corpo{padding:12px 10px 24px}
  .dg-grade{columns:1}
  .dg-duas{grid-template-columns:1fr}
  .dg-tempo::before,.dg-filme::before{left:58px}
  .dg-t-hora{width:46px;font-size:.7rem}
  .dg-dia{padding-left:72px!important}
  .dg-prob{flex-wrap:wrap}
  .dg-prob-sub{white-space:normal}
  .dg-c-topo{padding:12px}
  .dg-c-ic{display:none}
  .dg-c-corpo{padding:12px 10px 32px}
  .dg-m-itens{grid-template-columns:1fr}
}
@media print{
  .diag-raiz.dg-sobre{position:static;background:none;padding:0}
  .dg-acoes-topo,.dg-abas{display:none}
}
`;
