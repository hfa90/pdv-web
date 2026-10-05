// Catálogo de planos e pacotes adicionais (os preços vêm de assets/config.js).
import { PRECOS } from "./config.js";

export const PLANOS = {
  teste: { nome: "Teste grátis", desc: "7 dias com o sistema completo" },
  sistema: { nome: "Sistema", desc: "PDV completo para quem já tem equipamentos", preco: PRECOS.sistema },
  sistema_nota: { nome: "Sistema + Nota fiscal", desc: "PDV + NFC-e e NF-e (500 notas/mês)", preco: PRECOS.sistemaNota },
  combo: { nome: "Combo Completo", desc: "Equipamentos em comodato, nota fiscal e manutenção", preco: PRECOS.combo },
  kit_compra: { nome: "Kit comprado + plano", desc: "Equipamentos próprios com manutenção", preco: PRECOS.sistemaNota + PRECOS.manutencaoAvulsa },
  interno: { nome: "Interno", desc: "Conta da equipe, sem cobrança" },
};
export const nomePlano = (k) => PLANOS[k]?.nome || k;

// quantidade: pede quantos; recorrente: soma na mensalidade
export const PACOTES = [
  { id: "delivery", nome: "Delivery e cardápio digital", desc: "Pedidos pelo link no WhatsApp e Instagram, PIX e acompanhamento ao vivo. Sem comissão.", icone: "moto", cor: "#EA580C", preco: PRECOS.delivery, recorrente: true },
  { id: "garcom", nome: "App do garçom e mesas", desc: "Mapa do salão, comandas pelo celular e impressão na cozinha.", icone: "celular", cor: "#7C3AED", incluso: "restaurante" },
  { id: "nota_fiscal", nome: "Nota fiscal (NFC-e e NF-e)", desc: "Emissão de cupom fiscal e nota completa, 500 notas por mês.", icone: "nota", cor: "#2563EB", preco: PRECOS.sistemaNota - PRECOS.sistema, recorrente: true },
  { id: "caixa_extra", nome: "Caixa adicional com kit", desc: "Computador, impressora térmica e leitor para mais um caixa (comodato).", icone: "caixa", cor: "#136F63", preco: PRECOS.caixaExtra, recorrente: true, quantidade: true },
  { id: "gaveta", nome: "Gaveta de dinheiro", desc: "Abre sozinha ao imprimir o cupom. Por caixa.", icone: "dinheiro", cor: "#B45309", preco: PRECOS.gaveta, recorrente: true, quantidade: true },
  { id: "notebook", nome: "Notebook no lugar do desktop", desc: "Mais mobilidade para o caixa. Por caixa.", icone: "celular", cor: "#0891B2", preco: PRECOS.notebook, recorrente: true, quantidade: true },
  { id: "notas_extras", nome: "Notas fiscais extras", desc: "Para quem passa de 500 notas por mês.", icone: "vendas", cor: "#DB2777", preco: PRECOS.notaExcedente, unidade: "por nota" },
  { id: "balanca", nome: "Instalação de balança", desc: "Ligamos e configuramos sua balança Toledo, Filizola, Urano ou Elgin no caixa.", icone: "balanca", cor: "#16A34A", sobConsulta: true },
  { id: "etiquetas", nome: "Impressora de etiquetas", desc: "Etiquetas de gôndola e produtos com código de barras e QR Code.", icone: "barras", cor: "#475569", sobConsulta: true },
  { id: "treinamento", nome: "Treinamento da equipe", desc: "Nova turma de caixas ou gerentes? Treinamos por vídeo ou na loja.", icone: "suporte", cor: "#9333EA", sobConsulta: true },
];
export const nomePacote = (id) => PACOTES.find((p) => p.id === id)?.nome || (id.startsWith("plano_") ? `Mudar para ${nomePlano(id.slice(6))}` : id);
