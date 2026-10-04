// Configuração única do site e do sistema. Altere aqui e vale para tudo.

// Marca exibida no site e no sistema
export const MARCA = "Lis PDV";

// WhatsApp comercial com DDI e DDD, só números (ex.: "5592999990000").
// Enquanto estiver vazio, os botões de WhatsApp ficam escondidos e os contatos chegam só pelo formulário.
export const WHATSAPP_VENDAS = "";

// Supabase (chave pública "anon": a segurança vem das regras do banco)
export const SUPABASE_URL = "https://bcdoiaojhytxeoullskz.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjZG9pYW9qaHl0eGVvdWxsc2t6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNzk1OTEsImV4cCI6MjEwNjY1NTU5MX0.mL1Q86QquCI7FslgdcLNe8Iu9OpsGJb14DDZVVJn8Ng";

// Preços (R$). Mudou aqui, muda no site e no simulador.
export const PRECOS = {
  sistema: 99.9,           // só o sistema, sem nota fiscal
  sistemaNota: 149.9,      // sistema + NFC-e/NF-e
  combo: 349.9,            // kit desktop em comodato + sistema + nota + manutenção (fidelidade 24 meses)
  comboPromo: 299.9,       // 3 primeiros meses para quem contrata durante o teste
  caixaExtra: 199.9,       // cada caixa adicional com kit (comodato)
  notebook: 49.9,          // trocar o desktop por notebook (por caixa)
  gaveta: 24.9,            // gaveta de dinheiro (por caixa)
  manutencaoAvulsa: 59.9,  // manutenção dos equipamentos para quem comprou o kit (por caixa)
  kitCompra: 3290,         // kit desktop vendido, instalado e configurado
  gavetaCompra: 590,       // gaveta vendida junto com o kit
  instalacao: 390,         // taxa de instalação (isenta no combo)
  delivery: 49.9,          // cardápio digital + delivery, sem comissão por pedido (garçom/mesas já incluso para restaurantes)
  notaExcedente: 0.10,     // por NFC-e acima de 500/mês
};

export const linkWhatsApp = (texto = "") =>
  WHATSAPP_VENDAS ? `https://wa.me/${WHATSAPP_VENDAS}?text=${encodeURIComponent(texto)}` : null;
