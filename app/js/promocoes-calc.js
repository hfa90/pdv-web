// Cálculo das promoções no navegador. É o espelho EXATO de private.calcular_promocoes
// (supabase/migrations/011_gestao.sql): o PDV mostra o mesmo total que o servidor vai gravar,
// inclusive vendendo sem internet. Se mudar uma regra aqui, mude lá também.
//
// itens: [{ i, produto_id, categoria_id, quantidade, preco }]
// → Map(i → { desconto, promocao })

// Arredonda como o Postgres (numeric, meio para cima) sem o erro do ponto flutuante (4,475 → 4,48)
const r2 = (x) => Math.round(+(+(+x).toPrecision(12) * 100).toPrecision(12)) / 100;

/** Data, dia da semana (0 = domingo) e hora "HH:MM:SS" no fuso da loja. */
function local(quando, fuso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso || "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(quando).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { dia: `${p.year}-${p.month}-${p.day}`, dow, hora: `${p.hour}:${p.minute}:${p.second}` };
}
const hhmmss = (t) => (t ? (t.length === 5 ? t + ":00" : t.slice(0, 8)) : null);

export function promocaoAtiva(pr, quando = new Date(), fuso) {
  if (!pr.ativo) return false;
  const { dia, dow, hora } = local(quando, fuso);
  if (pr.data_inicio && dia < pr.data_inicio) return false;
  if (pr.data_fim && dia > pr.data_fim) return false;
  if (pr.dias_semana?.length && !pr.dias_semana.includes(dow)) return false;
  const ini = hhmmss(pr.hora_inicio), fim = hhmmss(pr.hora_fim);
  if (ini && fim) {
    if (ini <= fim) { if (!(hora >= ini && hora < fim)) return false; }
    else if (!(hora >= ini || hora < fim)) return false;
  }
  return true;
}

export function calcularPromocoes(promocoes, itens, quando = new Date(), fuso) {
  const res = new Map();
  if (!itens.length || !promocoes?.length) return res;
  const melhor = (i, desc, nome) => { if (desc > (res.get(i)?.desconto || 0)) res.set(i, { desconto: desc, promocao: nome }); };
  const qtdProduto = (pid) => itens.filter((x) => x.produto_id === pid).reduce((a, x) => a + Number(x.quantidade), 0);
  const ordem = [...promocoes].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));

  for (const pr of ordem) {
    if (!promocaoAtiva(pr, quando, fuso)) continue;
    if (["preco_horario", "atacado", "leve_pague"].includes(pr.tipo)) {
      for (const it of itens) {
        const aplica = (pr.produtos || []).includes(it.produto_id) || (pr.categoria_id && it.categoria_id === pr.categoria_id);
        if (!aplica) continue;
        let cand = 0;
        const q = qtdProduto(it.produto_id);
        const preco = Number(it.preco);
        if (pr.tipo === "preco_horario" || pr.tipo === "atacado") {
          if (pr.tipo === "preco_horario" || q >= Number(pr.qtd_minima || 0)) {
            const unit = preco - (pr.preco != null ? Number(pr.preco) : r2(preco * (1 - Number(pr.percentual) / 100)));
            if (unit > 0) cand = r2(Number(it.quantidade) * unit);
          }
        } else if (pr.leve && pr.pague && pr.pague < pr.leve && Number.isInteger(q)) {
          const total = Math.floor(q / pr.leve) * (pr.leve - pr.pague) * preco;
          cand = r2(total * Number(it.quantidade) / q);
        }
        melhor(it.i, cand, pr.nome);
      }
    } else if (pr.tipo === "combo" && Array.isArray(pr.combo) && pr.combo.length && pr.preco != null) {
      let n = null, normal = 0;
      for (const c of pr.combo) {
        const linhas = itens.filter((x) => x.produto_id === c.produto_id);
        const q = linhas.reduce((a, x) => a + Number(x.quantidade), 0);
        const unit = linhas.length ? Math.max(...linhas.map((x) => Number(x.preco))) : 0;
        const k = Math.max(Number(c.qtd), 1);
        n = Math.min(n ?? 1e9, Math.floor(q / k));
        normal += unit * k;
      }
      if (!(n >= 1) || normal <= Number(pr.preco)) continue;
      const total = r2(n * (normal - Number(pr.preco)));
      const ids = new Set(pr.combo.map((c) => c.produto_id));
      const linhas = itens.filter((x) => ids.has(x.produto_id)).sort((a, b) => a.i - b.i);
      const base = linhas.reduce((a, x) => a + Number(x.quantidade) * Number(x.preco), 0);
      let acum = 0;
      linhas.forEach((it, k) => {
        const lin = k === linhas.length - 1 ? r2(total - acum) : r2(total * Number(it.quantidade) * Number(it.preco) / base);
        acum = r2(acum + lin);
        melhor(it.i, lin, pr.nome);
      });
    }
  }
  // Nunca mais que o valor da linha
  for (const it of itens) {
    const x = res.get(it.i);
    if (x) x.desconto = Math.min(x.desconto, r2(Number(it.quantidade) * Number(it.preco)));
    if (x && !(x.desconto > 0)) res.delete(it.i);
  }
  return res;
}

export const NOMES_TIPO = {
  leve_pague: "Leve X, pague Y",
  preco_horario: "Preço especial (dia/horário)",
  atacado: "Preço de atacado (a partir de X unidades)",
  combo: "Combo",
};
