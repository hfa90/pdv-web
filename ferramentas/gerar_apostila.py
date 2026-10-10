#!/usr/bin/env python3
"""
Gera a apostila em PDF (assets/Manual-PDV.pdf) a partir da Central de Ajuda.

O texto vem de app/js/ajuda/artigos.js, telas.js e do catálogo do Diagnóstico,
montado pela página app/apostila.html. Assim a apostila e a Ajuda do sistema
dizem sempre a mesma coisa: atualize os artigos e rode este script.

Requisitos: pip install playwright && playwright install chromium ; poppler (pdftotext)
Uso:        python3 ferramentas/gerar_apostila.py [saida.pdf]
"""
import asyncio, functools, http.server, os, re, subprocess, sys, tempfile, threading

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAIDA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RAIZ, "assets", "Manual-PDV.pdf")


def servidor():
    class Quieto(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    h = functools.partial(Quieto, directory=RAIZ)
    s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def paginas_dos_capitulos(pdf, total):
    """Procura “Capítulo N” em cada página do PDF (primeira ocorrência depois do sumário)."""
    achou = {}
    n_pag = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout).group(1))
    for pg in range(3, n_pag + 1):
        t = subprocess.run(["pdftotext", "-f", str(pg), "-l", str(pg), "-layout", pdf, "-"], capture_output=True, text=True).stdout
        for m in re.finditer(r"CAP[IÍ]TULO (\d+)\b", t, re.I):
            achou.setdefault(m.group(1), pg)
    return achou, n_pag


async def main():
    from playwright.async_api import async_playwright
    s = servidor()
    url = f"http://127.0.0.1:{s.server_address[1]}/app/apostila.html"
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page()
        await pg.goto(url)
        await pg.wait_for_function("window.apostilaPronta === true", timeout=60000)
        caps = await pg.evaluate("window.capitulos")
        opcoes = dict(format="A4", print_background=True, prefer_css_page_size=True, outline=True, tagged=True)
        with tempfile.TemporaryDirectory() as tmp:
            rascunho = os.path.join(tmp, "rascunho.pdf")
            await pg.pdf(path=rascunho, **opcoes)
            mapa, n_pag = paginas_dos_capitulos(rascunho, len(caps))
        await pg.evaluate("m => window.preencherPaginas(m)", mapa)
        await pg.pdf(path=SAIDA, **opcoes)
        await b.close()
    s.shutdown()
    faltou = [c["n"] for c in caps if str(c["n"]) not in mapa]
    print(f"Apostila gerada: {SAIDA} ({n_pag} páginas, {len(caps)} capítulos)" + (f" — sem página no sumário: {faltou}" if faltou else ""))


if __name__ == "__main__":
    asyncio.run(main())
