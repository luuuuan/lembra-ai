// Escolhe por onde o WhatsApp funciona, pela variável WHATSAPP_PROVEDOR:
//   baileys (padrão) -> seu chip, conectado pelo QR code. Grátis, mas pode ser bloqueado com muitos envios.
//   oficial          -> WhatsApp Cloud API da Meta. Botões de verdade e sem risco de bloqueio, paga por aviso.
// O resto do sistema só fala com este arquivo, então trocar de um pro outro é só mudar a variável.
const OFICIAL = String(process.env.WHATSAPP_PROVEDOR || 'baileys').trim().toLowerCase() === 'oficial';
const m = OFICIAL ? await import('./whatsapp-oficial.js') : await import('./whatsapp-baileys.js');
console.log(`WhatsApp: usando ${OFICIAL ? 'a API oficial da Meta' : 'o chip conectado por QR code (Baileys)'}.`);

const naoTem = (nome) => () => { throw new Error(`${nome} não existe no modo ${OFICIAL ? 'oficial' : 'baileys'}`); };

export const MODO = OFICIAL ? 'oficial' : 'baileys';
export const {
  getStatus, getQr, online, conectar, desconectar, iniciar, resolverNumero, enviarTexto, enviarCodigo, quandoChegarMensagem,
} = m;
// só no chip (Baileys): enquete de toque
export const enviarEnquete = m.enviarEnquete || naoTem('enviarEnquete');
export const lerVoto = m.lerVoto || naoTem('lerVoto');
export const quandoChegarVoto = m.quandoChegarVoto || (() => {});
// só na API oficial: modelo com botões, lista de opções e webhook
export const enviarModeloAviso = m.enviarModeloAviso || naoTem('enviarModeloAviso');
export const enviarLista = m.enviarLista || naoTem('enviarLista');
export const enviarBotoes = m.enviarBotoes || naoTem('enviarBotoes');
export const quandoChegarEscolha = m.quandoChegarEscolha || (() => {});
export const rotasWebhook = m.rotasWebhook || (() => {});
