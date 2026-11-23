// Limites de tentativas (em memória). Cada limite conta eventos por chave (IP, e-mail...)
// dentro de uma janela de tempo e diz quanto falta pra liberar.

export function criarLimite({ max, janelaMin }) {
  const janela = janelaMin * 60_000;
  const registros = new Map(); // chave -> [timestamps]

  const recentes = (chave) => (registros.get(chave) || []).filter((t) => t > Date.now() - janela);

  // limpa chaves antigas de vez em quando, pra memória não crescer
  setInterval(() => {
    for (const [chave] of registros) {
      const r = recentes(chave);
      if (r.length) registros.set(chave, r); else registros.delete(chave);
    }
  }, 10 * 60_000).unref();

  return {
    // { liberado, esperaSeg }
    checar(chave) {
      const r = recentes(chave);
      if (r.length < max) return { liberado: true, esperaSeg: 0 };
      return { liberado: false, esperaSeg: Math.max(1, Math.ceil((r[0] + janela - Date.now()) / 1000)) };
    },
    registrar(chave) {
      registros.set(chave, [...recentes(chave), Date.now()]);
    },
    zerar(chave) {
      registros.delete(chave);
    },
  };
}

export function textoEspera(segundos) {
  if (segundos < 60) return `${segundos} segundos`;
  const min = Math.ceil(segundos / 60);
  return min === 1 ? '1 minuto' : `${min} minutos`;
}

// Responde 429 com o tempo de espera (e o cabeçalho Retry-After)
export function recusar(res, esperaSeg, motivo = 'Muitas tentativas') {
  res.set('Retry-After', String(esperaSeg));
  return res.status(429).json({ erro: `${motivo}. Tente de novo em ${textoEspera(esperaSeg)}.`, esperaSeg });
}
