// A libsignal (usada pelo Baileys) imprime as sessões de criptografia inteiras no console,
// inclusive chaves privadas. Não é erro, só poluição — e não deve ir pro log do Render.
const ruido = [
  'Closing session',
  'Opening session',
  'Removing old closed session',
  'Session already closed',
  'Session already open',
  'Closing open session',
  'Migrating session to',
];

for (const metodo of ['info', 'warn', 'log']) {
  const original = console[metodo].bind(console);
  console[metodo] = (...args) => {
    if (typeof args[0] === 'string' && ruido.some((r) => args[0].startsWith(r))) return;
    original(...args);
  };
}
