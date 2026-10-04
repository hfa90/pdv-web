// Endereços públicos derivados do lugar onde o sistema está publicado (/app/).
const base = () => new URL("../", location.href.split("#")[0]);
export const linkCardapio = (slug) => new URL(`cardapio/?loja=${encodeURIComponent(slug)}`, base()).href;
export const linkGarcom = () => new URL("garcom/", base()).href;
