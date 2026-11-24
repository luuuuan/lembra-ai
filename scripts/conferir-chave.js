// Mostra o código de uma CHAVE_DADOS, pra saber se é a chave que cifrou os dados.
// Uso: npm run conferir-chave -- "COLE_A_CHAVE_AQUI"
// O código é o mesmo que aparece no log do Render: "Criptografia dos dados ligada (chave xxxxxxxx)"
// ou na mensagem de erro "Dado cifrado com uma chave que o servidor não tem (xxxxxxxx)".
import { createHmac } from 'node:crypto';

const chaves = process.argv.slice(2).filter(Boolean);
if (!chaves.length) {
  console.log('\nUso: npm run conferir-chave -- "COLE_A_CHAVE_AQUI"   (pode passar várias, separadas por espaço)\n');
  process.exit(1);
}
console.log('');
for (const texto of chaves) {
  const bytes = Buffer.from(texto.trim(), 'base64');
  if (bytes.length !== 32) { console.log(`${texto.slice(0, 6)}…  -> não é uma chave válida (precisa ter 32 bytes em base64)`); continue; }
  const id = createHmac('sha256', bytes).update('id-da-chave').digest('hex').slice(0, 8);
  console.log(`${texto.slice(0, 6)}…  -> código ${id}`);
}
console.log('');
